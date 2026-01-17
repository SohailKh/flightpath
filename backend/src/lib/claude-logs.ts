import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_STORAGE_ROOT } from "./claude-paths";

/**
 * Resolve the .claude root directory for a given claudeStorageId
 * Falls back to a "default" storage location if no claudeStorageId is provided
 */
export function resolveClaudeRoot(claudeStorageId?: string): string {
  if (!claudeStorageId) {
    return join(CLAUDE_STORAGE_ROOT, "default");
  }
  return join(CLAUDE_STORAGE_ROOT, claudeStorageId);
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

function ensureFeatureDir(featurePrefix: string, claudeStorageId?: string): string {
  const safePrefix = normalizeFeaturePrefix(featurePrefix);
  const claudeRoot = resolveClaudeRoot(claudeStorageId);
  ensureDir(claudeRoot);
  const featureDir = join(claudeRoot, safePrefix);
  ensureDir(featureDir);
  ensureDir(join(featureDir, "artifacts"));
  return featureDir;
}

function getEventsPath(featurePrefix: string, claudeStorageId?: string): string {
  return join(ensureFeatureDir(featurePrefix, claudeStorageId), "events.ndjson");
}

function getProgressPath(featurePrefix: string, claudeStorageId?: string): string {
  return join(ensureFeatureDir(featurePrefix, claudeStorageId), "claude-progress.md");
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
  epicId?: string;
  priority?: number;
};

type FeatureSpecCacheEntry = {
  featureName?: string;
  requirements: FeatureRequirement[];
  requirementTitles: Map<string, string>;
  requirementEpicIds: Map<string, string>;
  epicTitles: Map<string, string>;
};

const featureSpecCache = new Map<string, FeatureSpecCacheEntry>();
const featureSpecFailures = new Set<string>();

function getFeatureSpecCacheKey(featurePrefix: string, claudeStorageId?: string): string {
  const root = resolveClaudeRoot(claudeStorageId);
  const safePrefix = normalizeFeaturePrefix(featurePrefix);
  return `${root}::${safePrefix}`;
}

function loadFeatureSpec(featurePrefix: string, claudeStorageId?: string): FeatureSpecCacheEntry | null {
  const cacheKey = getFeatureSpecCacheKey(featurePrefix, claudeStorageId);
  if (featureSpecCache.has(cacheKey)) {
    return featureSpecCache.get(cacheKey) ?? null;
  }

  const featureDir = ensureFeatureDir(featurePrefix, claudeStorageId);
  // Check for both v4 (feature-spec.json) and legacy (feature-spec.v3.json) formats
  const specFileNames = ["feature-spec.json", "feature-spec.v3.json"];
  let specPath: string | null = null;
  for (const fileName of specFileNames) {
    const candidate = join(featureDir, fileName);
    if (existsSync(candidate)) {
      specPath = candidate;
      break;
    }
  }
  if (!specPath) {
    return null;
  }

  try {
    const raw = readFileSync(specPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      featureName?: unknown;
      epics?: Array<Record<string, unknown>>;
      requirements?: Array<Record<string, unknown>>;
    };
    const featureName =
      typeof parsed.featureName === "string" ? parsed.featureName.trim() : "";
    const rawEpics = Array.isArray(parsed.epics) ? parsed.epics : [];
    const epicTitles = new Map<string, string>();
    for (const epic of rawEpics) {
      if (!epic || typeof epic !== "object") continue;
      const id = typeof epic.id === "string" && epic.id.trim() ? epic.id : "";
      if (!id) continue;
      const title = typeof epic.title === "string" && epic.title.trim() ? epic.title : id;
      epicTitles.set(id, title);
    }

    const rawRequirements = Array.isArray(parsed.requirements) ? parsed.requirements : [];
    const requirements = rawRequirements.map((req, index) => {
      const id = typeof req.id === "string" && req.id.trim() ? req.id : `req-${index + 1}`;
      const title = typeof req.title === "string" ? req.title : "";
      const description = typeof req.description === "string" ? req.description : "";
      const epicId = typeof req.epicId === "string" && req.epicId.trim() ? req.epicId : undefined;
      const priority = typeof req.priority === "number" ? req.priority : undefined;
      return { id, title, description, epicId, priority };
    });
    const requirementTitles = new Map<string, string>();
    const requirementEpicIds = new Map<string, string>();
    for (const req of requirements) {
      if (req.id && req.title) {
        requirementTitles.set(req.id, req.title);
      }
      if (req.id && req.epicId) {
        requirementEpicIds.set(req.id, req.epicId);
      }
    }
    const entry = {
      featureName: featureName || undefined,
      requirements,
      requirementTitles,
      requirementEpicIds,
      epicTitles,
    };
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

function lookupRequirementTitle(
  featurePrefix: string,
  requirementId: string,
  claudeStorageId?: string
): string | null {
  const spec = loadFeatureSpec(featurePrefix, claudeStorageId);
  if (!spec) return null;
  const title = spec.requirementTitles.get(requirementId);
  return title && title.trim() ? title : null;
}

function formatRequirementLabel(
  featurePrefix: string,
  requirementId: string,
  claudeStorageId?: string
): string {
  const title = lookupRequirementTitle(featurePrefix, requirementId, claudeStorageId);
  return title ? `${requirementId}: ${title}` : requirementId;
}

type RequirementProgressStatus = "pending" | "in_progress" | "completed" | "failed";

type SessionBlockInput = {
  sessionNumber: number;
  date: string;
  completedLabel: string;
  epicLabel: string;
  commits: string[];
  done: string[];
  blocked: string[];
  next: string[];
};

function buildProgressHeader(featurePrefix: string, claudeStorageId?: string): string {
  const spec = loadFeatureSpec(featurePrefix, claudeStorageId);
  const featureName = spec?.featureName?.trim();
  if (featureName) {
    return `# ${featureName} - Progress Log\n\n`;
  }
  return "# Claude Progress\n\n";
}

function ensureProgressLogHeader(featurePrefix: string, claudeStorageId?: string): void {
  const progressPath = getProgressPath(featurePrefix, claudeStorageId);
  if (existsSync(progressPath)) {
    const content = readFileSync(progressPath, "utf-8");
    if (content.trim()) {
      return;
    }
  }
  writeFileSync(progressPath, buildProgressHeader(featurePrefix, claudeStorageId), "utf-8");
}

function formatSessionDate(value?: string): string {
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) {
      return date.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function getOrderedRequirements(spec: FeatureSpecCacheEntry): FeatureRequirement[] {
  const hasPriority = spec.requirements.some((req) => typeof req.priority === "number");
  if (!hasPriority) {
    return spec.requirements;
  }
  return spec.requirements
    .map((req, index) => ({ req, index }))
    .sort((a, b) => {
      const aPriority = a.req.priority ?? Number.MAX_SAFE_INTEGER;
      const bPriority = b.req.priority ?? Number.MAX_SAFE_INTEGER;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.req);
}

function getEpicTitleForRequirement(
  featurePrefix: string,
  requirementId: string,
  claudeStorageId?: string
): string | null {
  const spec = loadFeatureSpec(featurePrefix, claudeStorageId);
  if (!spec) return null;
  const epicId = spec.requirementEpicIds.get(requirementId);
  if (!epicId) return null;
  return spec.epicTitles.get(epicId) ?? epicId;
}

function extractCommitHashes(data: Record<string, unknown>): string[] {
  const commits: string[] = [];
  const singleKeys = ["commit", "commitHash", "gitCommit", "hash"];
  for (const key of singleKeys) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) {
      commits.push(value.trim());
    }
  }
  const listKeys = ["commits", "commitHashes", "hashes"];
  for (const key of listKeys) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) {
        commits.push(entry.trim());
      }
    }
  }
  return Array.from(new Set(commits));
}

function formatCommitList(commits: string[]): string {
  if (commits.length === 0) return "None";
  return commits.map((commit) => `\`${commit}\``).join(", ");
}

function normalizeListItems(items: string[]): string[] {
  const filtered = items
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (filtered.length === 0) {
    return ["- None"];
  }
  return filtered.map((item) => (item.startsWith("- ") ? item : `- ${item}`));
}

function formatSessionBlock(input: SessionBlockInput): string {
  const doneLines = normalizeListItems(input.done);
  const blockedLines = normalizeListItems(input.blocked);
  const nextLines = normalizeListItems(input.next);
  const commits = formatCommitList(input.commits);
  const epicLabel = input.epicLabel || "Unknown";

  return [
    `## Session ${input.sessionNumber} - ${input.date}`,
    "",
    `**Completed:** ${input.completedLabel} | **Epic:** ${epicLabel}`,
    `**Commits:** ${commits}`,
    "",
    "### Done",
    ...doneLines,
    "",
    "### Blocked",
    ...blockedLines,
    "",
    "### Next",
    ...nextLines,
    "",
    "---",
    "",
  ].join("\n");
}

function loadRequirementStatuses(
  featurePrefix: string,
  claudeStorageId?: string
): Map<string, RequirementProgressStatus> {
  const statuses = new Map<string, RequirementProgressStatus>();
  const eventsPath = getEventsPath(featurePrefix, claudeStorageId);
  if (!existsSync(eventsPath)) return statuses;
  const raw = readFileSync(eventsPath, "utf-8");
  if (!raw.trim()) return statuses;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
      const data = parsed.data ?? {};
      const requirementId =
        typeof data.requirementId === "string" ? data.requirementId.trim() : "";
      if (!requirementId) continue;
      switch (parsed.type) {
        case "requirement_started":
          if (!statuses.has(requirementId)) {
            statuses.set(requirementId, "in_progress");
          }
          break;
        case "requirement_completed":
          statuses.set(requirementId, "completed");
          break;
        case "requirement_failed":
          statuses.set(requirementId, "failed");
          break;
        default:
          break;
      }
    } catch {
      continue;
    }
  }
  return statuses;
}

function getNextRequirementIdFromStatus(
  spec: FeatureSpecCacheEntry | null,
  statuses: Map<string, RequirementProgressStatus>
): string | null {
  if (!spec) return null;
  const ordered = getOrderedRequirements(spec);
  for (const requirement of ordered) {
    const status = statuses.get(requirement.id);
    if (status !== "completed" && status !== "failed") {
      return requirement.id;
    }
  }
  return null;
}

function getNextRequirementLabel(
  featurePrefix: string,
  claudeStorageId?: string
): string | null {
  const spec = loadFeatureSpec(featurePrefix, claudeStorageId);
  if (!spec) return null;
  const statuses = loadRequirementStatuses(featurePrefix, claudeStorageId);
  const nextRequirementId = getNextRequirementIdFromStatus(spec, statuses);
  if (!nextRequirementId) return null;
  return formatRequirementLabel(featurePrefix, nextRequirementId, claudeStorageId);
}

function appendInitSessionIfNeeded(
  featurePrefix: string,
  claudeStorageId?: string,
  dateOverride?: string
): boolean {
  const progressPath = getProgressPath(featurePrefix, claudeStorageId);
  ensureProgressLogHeader(featurePrefix, claudeStorageId);
  const content = existsSync(progressPath) ? readFileSync(progressPath, "utf-8") : "";
  if (countSessions(content) > 0) return false;

  const spec = loadFeatureSpec(featurePrefix, claudeStorageId);
  const ordered = spec ? getOrderedRequirements(spec) : [];
  const firstRequirement = ordered[0];
  const epicLabel = firstRequirement
    ? getEpicTitleForRequirement(featurePrefix, firstRequirement.id, claudeStorageId) ?? "Unknown"
    : "Unknown";
  const totalRequirements = spec?.requirements.length ?? 0;
  const done = [
    totalRequirements > 0
      ? `Feature initialized with ${totalRequirements} requirements`
      : "Feature initialized",
  ];
  const next = firstRequirement
    ? [formatRequirementLabel(featurePrefix, firstRequirement.id, claudeStorageId)]
    : ["None"];

  const block = formatSessionBlock({
    sessionNumber: 1,
    date: formatSessionDate(dateOverride),
    completedLabel: "None (init)",
    epicLabel,
    commits: [],
    done,
    blocked: ["None"],
    next,
  });
  appendFileSync(progressPath, block, "utf-8");
  return true;
}

function appendRequirementSession(
  featurePrefix: string,
  event: { ts: string; type: string; data: Record<string, unknown> },
  claudeStorageId?: string,
  nextRequirementLabel?: string | null
): void {
  const progressPath = getProgressPath(featurePrefix, claudeStorageId);
  ensureProgressLogHeader(featurePrefix, claudeStorageId);
  const content = existsSync(progressPath) ? readFileSync(progressPath, "utf-8") : "";
  const sessionNumber = countSessions(content) + 1;

  const data = event.data ?? {};
  const requirementId =
    typeof data.requirementId === "string" && data.requirementId.trim()
      ? data.requirementId.trim()
      : "unknown";
  const epicLabel =
    getEpicTitleForRequirement(featurePrefix, requirementId, claudeStorageId) ?? "Unknown";
  const commits = extractCommitHashes(data);

  const summary = typeof data.summary === "string" ? data.summary.trim() : "";
  const done: string[] = [];
  if (event.type === "requirement_completed") {
    done.push(formatRequirementLabel(featurePrefix, requirementId, claudeStorageId));
    if (summary) {
      done.push(`Summary: ${truncate(summary, 160)}`);
    }
  }

  const blocked: string[] = [];
  if (event.type === "requirement_failed") {
    const reason = typeof data.reason === "string" ? data.reason.trim() : "";
    const blockedBy = Array.isArray(data.blockedBy)
      ? data.blockedBy.filter((entry) => typeof entry === "string" && entry.trim())
      : [];
    const details: string[] = [];
    if (reason) details.push(truncate(reason, 160));
    if (blockedBy.length > 0) {
      details.push(`Blocked by: ${blockedBy.join(", ")}`);
    }
    const label = formatRequirementLabel(featurePrefix, requirementId, claudeStorageId);
    blocked.push(details.length > 0 ? `${label} - ${details.join(" | ")}` : label);
  }

  const nextLabel =
    nextRequirementLabel !== undefined
      ? nextRequirementLabel
      : getNextRequirementLabel(featurePrefix, claudeStorageId);

  const block = formatSessionBlock({
    sessionNumber,
    date: formatSessionDate(event.ts),
    completedLabel:
      event.type === "requirement_completed" ? requirementId : "None (blocked)",
    epicLabel,
    commits,
    done,
    blocked,
    next: nextLabel ? [nextLabel] : ["None"],
  });
  appendFileSync(progressPath, block, "utf-8");
}

export function startProgressSession(
  featurePrefix: string,
  pipelineId: string,
  claudeStorageId?: string
): number {
  ensureProgressLogHeader(featurePrefix, claudeStorageId);
  const progressPath = getProgressPath(featurePrefix, claudeStorageId);
  const content = existsSync(progressPath) ? readFileSync(progressPath, "utf-8") : "";
  const sessionCount = countSessions(content);

  if (sessionCount === 0) {
    appendInitSessionIfNeeded(featurePrefix, claudeStorageId);
    return 1;
  }

  return sessionCount + 1;
}

export function backfillPipelineEventLog(
  featurePrefix: string,
  pipelineId: string,
  events: Array<{ ts: string; type: string; data: Record<string, unknown> }>,
  claudeStorageId?: string
): void {
  const eventsPath = getEventsPath(featurePrefix, claudeStorageId);

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
  claudeStorageId?: string
): void {
  const eventsPath = getEventsPath(featurePrefix, claudeStorageId);
  const line = JSON.stringify({ ...event, pipelineId });
  appendFileSync(eventsPath, `${line}\n`, "utf-8");
}

export function backfillProgressLog(
  featurePrefix: string,
  pipelineId: string,
  events: Array<{ ts: string; type: string; data: Record<string, unknown> }>,
  claudeStorageId?: string
): number | null {
  const progressPath = getProgressPath(featurePrefix, claudeStorageId);

  if (existsSync(progressPath) && statSync(progressPath).size > 0) {
    return null;
  }

  ensureProgressLogHeader(featurePrefix, claudeStorageId);
  const initEvent = events.find((event) => event.type === "requirements_ready");
  appendInitSessionIfNeeded(featurePrefix, claudeStorageId, initEvent?.ts);

  const spec = loadFeatureSpec(featurePrefix, claudeStorageId);
  const statuses = new Map<string, RequirementProgressStatus>();

  for (const event of events) {
    const data = event.data ?? {};
    const requirementId =
      typeof data.requirementId === "string" ? data.requirementId.trim() : "";
    if (!requirementId) continue;

    switch (event.type) {
      case "requirement_started":
        if (!statuses.has(requirementId)) {
          statuses.set(requirementId, "in_progress");
        }
        break;
      case "requirement_completed":
        statuses.set(requirementId, "completed");
        break;
      case "requirement_failed":
        statuses.set(requirementId, "failed");
        break;
      default:
        break;
    }

    if (event.type === "requirement_completed" || event.type === "requirement_failed") {
      const nextRequirementId = getNextRequirementIdFromStatus(spec, statuses);
      const nextLabel = nextRequirementId
        ? formatRequirementLabel(featurePrefix, nextRequirementId, claudeStorageId)
        : null;
      appendRequirementSession(featurePrefix, event, claudeStorageId, nextLabel);
    }
  }

  const finalContent = existsSync(progressPath) ? readFileSync(progressPath, "utf-8") : "";
  return countSessions(finalContent);
}

export function appendProgressLog(
  featurePrefix: string,
  pipelineId: string,
  event: { ts: string; type: string; data: Record<string, unknown> },
  claudeStorageId?: string
): void {
  ensureProgressLogHeader(featurePrefix, claudeStorageId);
  switch (event.type) {
    case "requirements_ready":
      appendInitSessionIfNeeded(featurePrefix, claudeStorageId, event.ts);
      break;
    case "requirement_completed":
    case "requirement_failed":
      appendRequirementSession(featurePrefix, event, claudeStorageId);
      break;
    default:
      break;
  }
}
