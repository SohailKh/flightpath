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

type FeatureRequirement = {
  id: string;
  title: string;
  description: string;
};

type FeatureSpecCacheEntry = {
  requirements: FeatureRequirement[];
  requirementTitles: Map<string, string>;
};

const featureSpecCache = new Map<string, FeatureSpecCacheEntry>();
const featureSpecFailures = new Set<string>();

function getFeatureSpecCacheKey(featurePrefix: string, rootPath?: string): string {
  const root = resolveRoot(rootPath);
  const safePrefix = normalizeFeaturePrefix(featurePrefix);
  return `${root}::${safePrefix}`;
}

function loadFeatureSpec(featurePrefix: string, rootPath?: string): FeatureSpecCacheEntry | null {
  const cacheKey = getFeatureSpecCacheKey(featurePrefix, rootPath);
  if (featureSpecCache.has(cacheKey)) {
    return featureSpecCache.get(cacheKey) ?? null;
  }

  const featureDir = ensureFeatureDir(featurePrefix, rootPath);
  const specPath = join(featureDir, "feature-spec.v3.json");
  if (!existsSync(specPath)) {
    return null;
  }

  try {
    const raw = readFileSync(specPath, "utf-8");
    const parsed = JSON.parse(raw) as { requirements?: Array<Record<string, unknown>> };
    const rawRequirements = Array.isArray(parsed.requirements) ? parsed.requirements : [];
    const requirements = rawRequirements.map((req, index) => {
      const id = typeof req.id === "string" && req.id.trim() ? req.id : `req-${index + 1}`;
      const title = typeof req.title === "string" ? req.title : "";
      const description = typeof req.description === "string" ? req.description : "";
      return { id, title, description };
    });
    const requirementTitles = new Map<string, string>();
    for (const req of requirements) {
      if (req.id && req.title) {
        requirementTitles.set(req.id, req.title);
      }
    }
    const entry = { requirements, requirementTitles };
    featureSpecCache.set(cacheKey, entry);
    featureSpecFailures.delete(cacheKey);
    return entry;
  } catch (error) {
    if (!featureSpecFailures.has(cacheKey)) {
      console.warn("[ClaudeLogs] Failed to parse feature spec:", error);
      featureSpecFailures.add(cacheKey);
    }
    return null;
  }
}

function formatFeatureLine(requirement: FeatureRequirement): string {
  const title = requirement.title || requirement.description || "Untitled requirement";
  const label = requirement.id ? `${requirement.id}: ${title}` : title;
  return truncate(label, 140);
}

function getLatestFeatures(featurePrefix: string, rootPath?: string): string[] {
  const spec = loadFeatureSpec(featurePrefix, rootPath);
  if (!spec || spec.requirements.length === 0) return [];
  return spec.requirements.slice(-3).map(formatFeatureLine);
}

function lookupRequirementTitle(
  featurePrefix: string,
  requirementId: string,
  rootPath?: string
): string | null {
  const spec = loadFeatureSpec(featurePrefix, rootPath);
  if (!spec) return null;
  const title = spec.requirementTitles.get(requirementId);
  return title && title.trim() ? title : null;
}

function formatRequirementLabel(
  featurePrefix: string,
  requirementId: string,
  rootPath?: string
): string {
  const title = lookupRequirementTitle(featurePrefix, requirementId, rootPath);
  return title ? `${requirementId}: ${title}` : requirementId;
}

function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

function isNoisyStatus(action: string): boolean {
  const lower = action.trim().toLowerCase();
  if (!lower) return true;
  if (lower === "analyzing..." || lower === "analyzing") return true;

  const noisyPrefixes = [
    "reading ",
    "writing ",
    "editing ",
    "searching ",
    "running:",
    "running ",
    "fetching ",
    "navigating ",
    "clicking ",
    "typing ",
    "taking screenshot",
  ];
  return noisyPrefixes.some((prefix) => lower.startsWith(prefix));
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

  const dateStamp = new Date().toISOString().slice(0, 10);
  appendFileSync(progressPath, `## Session ${sessionNumber} - ${dateStamp}\n`, "utf-8");
  appendFileSync(progressPath, `- Pipeline ${pipelineId}\n\n`, "utf-8");

  const latestFeatures = getLatestFeatures(featurePrefix, rootPath);
  if (latestFeatures.length > 0) {
    appendFileSync(progressPath, "### Latest Features\n", "utf-8");
    for (const feature of latestFeatures) {
      appendFileSync(progressPath, `- ${feature}\n`, "utf-8");
    }
    appendFileSync(progressPath, "\n", "utf-8");
  }

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
    const line = formatProgressLine(event, featurePrefix, rootPath);
    if (line) {
      appendFileSync(progressPath, `- ${line}\n`, "utf-8");
    }
  }

  return sessionNumber;
}

function formatProgressLine(
  event: {
    ts: string;
    type: string;
    data: Record<string, unknown>;
  },
  featurePrefix?: string,
  rootPath?: string
): string | null {
  const data = event.data || {};

  switch (event.type) {
    case "qa_started": {
      return "QA started.";
    }
    case "qa_completed": {
      return "QA completed.";
    }
    case "requirements_ready": {
      return "Requirements were generated.";
    }
    case "target_project_set": {
      const targetPath = data.targetPath ? String(data.targetPath) : "";
      const message = targetPath ? `Target project set to ${truncate(targetPath, 120)}` : "Target project set";
      return ensureSentence(message);
    }
    case "requirement_started": {
      const reqId = data.requirementId ? String(data.requirementId) : "unknown";
      const approach = data.approach ? truncate(String(data.approach)) : "";
      const label = featurePrefix ? formatRequirementLabel(featurePrefix, reqId, rootPath) : reqId;
      if (!approach) {
        return ensureSentence(`Started ${label}`);
      }
      return ensureSentence(`Started ${label}. Approach: ${approach}`);
    }
    case "requirement_completed": {
      const reqId = data.requirementId ? String(data.requirementId) : "unknown";
      const summary = data.summary ? truncate(String(data.summary)) : "";
      const label = featurePrefix ? formatRequirementLabel(featurePrefix, reqId, rootPath) : reqId;
      if (!summary) {
        return ensureSentence(`Completed ${label}`);
      }
      return ensureSentence(`Completed ${label}. Summary: ${summary}`);
    }
    case "requirement_failed": {
      const reqId = data.requirementId ? String(data.requirementId) : "unknown";
      const reason = data.reason ? truncate(String(data.reason)) : "";
      const label = featurePrefix ? formatRequirementLabel(featurePrefix, reqId, rootPath) : reqId;
      if (!reason) {
        return ensureSentence(`Failed ${label}`);
      }
      return ensureSentence(`Failed ${label}. Reason: ${reason}`);
    }
    case "test_passed": {
      const testName = data.name ? truncate(String(data.name)) : "";
      return ensureSentence(testName ? `Test passed: ${testName}` : "Test passed");
    }
    case "test_failed": {
      const testName = data.name ? truncate(String(data.name)) : "";
      return ensureSentence(testName ? `Test failed: ${testName}` : "Test failed");
    }
    case "pipeline_completed": {
      const completed = data.completed;
      const total = data.totalRequirements;
      if (typeof completed === "number" && typeof total === "number") {
        return ensureSentence(`Pipeline completed (${completed}/${total} requirements)`);
      }
      return "Pipeline completed.";
    }
    case "pipeline_failed": {
      const error = data.error ? truncate(String(data.error)) : "";
      return ensureSentence(error ? `Pipeline failed: ${error}` : "Pipeline failed");
    }
    case "aborted": {
      return "Pipeline aborted.";
    }
    case "status_update": {
      const statusSource = data.statusSource ? String(data.statusSource) : "";
      const action = data.action ? truncate(String(data.action)) : "";
      if (statusSource === "tool" || statusSource === "agent") {
        return null;
      }
      if (!statusSource && isNoisyStatus(action)) {
        return null;
      }
      return action ? ensureSentence(action) : null;
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
  const line = formatProgressLine(event, featurePrefix, rootPath);
  if (!line) return;

  const progressPath = getProgressPath(featurePrefix, rootPath);
  if (!existsSync(progressPath)) {
    startProgressSession(featurePrefix, pipelineId, rootPath);
  }

  appendFileSync(progressPath, `- ${line}\n`, "utf-8");
}
