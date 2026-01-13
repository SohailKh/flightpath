import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FLIGHTPATH_ROOT = resolve(import.meta.dirname, "..", "..");
const CLAUDE_ROOT = join(FLIGHTPATH_ROOT, ".claude");

function resolveRoot(rootPath?: string): string {
  if (!rootPath) return FLIGHTPATH_ROOT;
  return resolve(rootPath);
}

export function resolveClaudeRoot(rootPath?: string): string {
  return join(resolveRoot(rootPath), ".claude");
}

function normalizeFeaturePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return "pipeline";
  }
  return trimmed.replace(/[\\/]+/g, "-");
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function ensureFeatureDir(featurePrefix: string, rootPath?: string): string {
  const safePrefix = normalizeFeaturePrefix(featurePrefix);
  const claudeRoot = resolveClaudeRoot(rootPath);
  ensureDir(claudeRoot);
  const featureDir = join(claudeRoot, safePrefix);
  ensureDir(featureDir);
  ensureDir(join(featureDir, "artifacts"));
  return featureDir;
}

function getEventsPath(featurePrefix: string, rootPath?: string): string {
  return join(ensureFeatureDir(featurePrefix, rootPath), "events.ndjson");
}

function getProgressPath(featurePrefix: string, rootPath?: string): string {
  return join(ensureFeatureDir(featurePrefix, rootPath), "claude-progress.md");
}

function countSessions(content: string): number {
  const matches = content.match(/^## Session /gm);
  return matches ? matches.length : 0;
}

function truncate(value: string, max = 160): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 3) + "...";
}

export function startProgressSession(
  featurePrefix: string,
  pipelineId: string,
  rootPath?: string
): number {
  const progressPath = getProgressPath(featurePrefix, rootPath);
  let sessionNumber = 1;

  if (existsSync(progressPath)) {
    const content = readFileSync(progressPath, "utf-8");
    sessionNumber = countSessions(content) + 1;
  } else {
    writeFileSync(progressPath, "# Claude Progress\n\n", "utf-8");
  }

  const timestamp = new Date().toISOString();
  appendFileSync(progressPath, `## Session ${sessionNumber} - ${timestamp}\n`, "utf-8");
  appendFileSync(progressPath, `- Pipeline ${pipelineId}\n\n`, "utf-8");

  return sessionNumber;
}

export function backfillPipelineEventLog(
  featurePrefix: string,
  pipelineId: string,
  events: Array<{ ts: string; type: string; data: Record<string, unknown> }>,
  rootPath?: string
): void {
  const eventsPath = getEventsPath(featurePrefix, rootPath);

  if (existsSync(eventsPath) && statSync(eventsPath).size > 0) {
    return;
  }

  if (events.length === 0) {
    writeFileSync(eventsPath, "", "utf-8");
    return;
  }

  const lines = events.map((event) =>
    JSON.stringify({ ...event, pipelineId })
  );
  writeFileSync(eventsPath, lines.join("\n") + "\n", "utf-8");
}

export function appendPipelineEventLog(
  featurePrefix: string,
  pipelineId: string,
  event: { ts: string; type: string; data: Record<string, unknown> },
  rootPath?: string
): void {
  const eventsPath = getEventsPath(featurePrefix, rootPath);
  const line = JSON.stringify({ ...event, pipelineId });
  appendFileSync(eventsPath, `${line}\n`, "utf-8");
}

export function backfillProgressLog(
  featurePrefix: string,
  pipelineId: string,
  events: Array<{ ts: string; type: string; data: Record<string, unknown> }>,
  rootPath?: string
): number | null {
  const progressPath = getProgressPath(featurePrefix, rootPath);

  if (existsSync(progressPath) && statSync(progressPath).size > 0) {
    return null;
  }

  const sessionNumber = startProgressSession(featurePrefix, pipelineId, rootPath);

  for (const event of events) {
    const line = formatProgressLine(event);
    if (line) {
      appendFileSync(progressPath, `- ${line}\n`, "utf-8");
    }
  }

  return sessionNumber;
}

function formatProgressLine(event: {
  ts: string;
  type: string;
  data: Record<string, unknown>;
}): string | null {
  const ts = event.ts;
  const data = event.data || {};

  switch (event.type) {
    case "qa_started": {
      return `${ts} QA started`;
    }
    case "qa_completed": {
      return `${ts} QA completed`;
    }
    case "requirements_ready": {
      return `${ts} Requirements generated`;
    }
    case "target_project_set": {
      const targetPath = data.targetPath ? String(data.targetPath) : "";
      return targetPath ? `${ts} Target project set: ${targetPath}` : `${ts} Target project set`;
    }
    case "requirement_started": {
      const reqId = data.requirementId ? String(data.requirementId) : "unknown";
      const approach = data.approach ? truncate(String(data.approach)) : "";
      return approach
        ? `${ts} Requirement ${reqId} started: ${approach}`
        : `${ts} Requirement ${reqId} started`;
    }
    case "requirement_completed": {
      const reqId = data.requirementId ? String(data.requirementId) : "unknown";
      const summary = data.summary ? truncate(String(data.summary)) : "";
      return summary
        ? `${ts} Requirement ${reqId} completed: ${summary}`
        : `${ts} Requirement ${reqId} completed`;
    }
    case "requirement_failed": {
      const reqId = data.requirementId ? String(data.requirementId) : "unknown";
      const reason = data.reason ? truncate(String(data.reason)) : "";
      return reason
        ? `${ts} Requirement ${reqId} failed: ${reason}`
        : `${ts} Requirement ${reqId} failed`;
    }
    case "test_passed": {
      const testName = data.name ? truncate(String(data.name)) : "";
      return testName ? `${ts} Test passed: ${testName}` : `${ts} Test passed`;
    }
    case "test_failed": {
      const testName = data.name ? truncate(String(data.name)) : "";
      return testName ? `${ts} Test failed: ${testName}` : `${ts} Test failed`;
    }
    case "pipeline_completed": {
      const completed = data.completed;
      const total = data.totalRequirements;
      if (typeof completed === "number" && typeof total === "number") {
        return `${ts} Pipeline completed (${completed}/${total})`;
      }
      return `${ts} Pipeline completed`;
    }
    case "pipeline_failed": {
      const error = data.error ? truncate(String(data.error)) : "";
      return error ? `${ts} Pipeline failed: ${error}` : `${ts} Pipeline failed`;
    }
    case "aborted": {
      return `${ts} Pipeline aborted`;
    }
    case "status_update": {
      const action = data.action ? truncate(String(data.action)) : "";
      return action ? `${ts} ${action}` : `${ts} Status update`;
    }
    default:
      return null;
  }
}

export function appendProgressLog(
  featurePrefix: string,
  pipelineId: string,
  event: { ts: string; type: string; data: Record<string, unknown> },
  rootPath?: string
): void {
  const line = formatProgressLine(event);
  if (!line) return;

  const progressPath = getProgressPath(featurePrefix, rootPath);
  if (!existsSync(progressPath)) {
    startProgressSession(featurePrefix, pipelineId, rootPath);
  }

  appendFileSync(progressPath, `- ${line}\n`, "utf-8");
}
