import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initBrowser, closeBrowser, navigate, screenshot, wait } from "../lib/playwright-tools";
import { saveScreenshot, saveTestResult } from "../lib/artifacts";
import { getClaudeFeaturePath, CLAUDE_STORAGE_ROOT } from "../lib/claude-paths";

function parseArgs(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const trimmed = arg.slice(2);
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex !== -1) {
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      options[key] = value;
      continue;
    }
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      options[trimmed] = next;
      i++;
    } else {
      options[trimmed] = "true";
    }
  }
  return options;
}

/**
 * Resolve the feature prefix
 * Uses claudeStorageId if provided, otherwise falls back to projectPath
 */
async function resolveFeaturePrefix(
  claudeStorageId: string | undefined,
  projectPath: string,
  explicit?: string
): Promise<string> {
  if (explicit) return explicit;

  const claudeDir = claudeStorageId
    ? join(CLAUDE_STORAGE_ROOT, claudeStorageId)
    : join(projectPath, ".claude");

  if (!existsSync(claudeDir)) return "pipeline";
  const entries = await readdir(claudeDir, { withFileTypes: true });
  const candidates = entries.filter(
    (entry) => entry.isDirectory() && entry.name !== "skills"
  );
  for (const entry of candidates) {
    const specPath = join(claudeDir, entry.name, "feature-spec.v3.json");
    if (existsSync(specPath)) {
      return entry.name;
    }
  }
  return candidates[0]?.name ?? "pipeline";
}

/**
 * Resolve the run ID
 * Uses claudeStorageId if provided, otherwise falls back to projectPath
 */
async function resolveRunId(
  claudeStorageId: string | undefined,
  projectPath: string,
  featurePrefix: string,
  explicit?: string
): Promise<string> {
  if (explicit) return explicit;

  const claudeDir = claudeStorageId
    ? getClaudeFeaturePath(claudeStorageId, featurePrefix)
    : join(projectPath, ".claude", featurePrefix);

  const currentFeaturePath = join(claudeDir, "current-feature.json");
  if (!existsSync(currentFeaturePath)) {
    return `manual-${Date.now()}`;
  }
  try {
    const content = await readFile(currentFeaturePath, "utf-8");
    const parsed = JSON.parse(content) as { runId?: string };
    if (parsed.runId) return String(parsed.runId);
  } catch {
    // Fall back to a generated run id.
  }
  return `manual-${Date.now()}`;
}

const options = parseArgs(process.argv.slice(2));
const baseUrl =
  options.baseUrl || process.env.BASE_URL || process.env.LIVE_BASE_URL;

if (!baseUrl) {
  console.error(
    "Missing base URL. Provide --baseUrl or set BASE_URL/LIVE_BASE_URL."
  );
  process.exit(1);
}

const projectPath = resolve(options.projectPath || process.cwd());
const claudeStorageId = options.claudeStorageId || undefined;

const featurePrefix = await resolveFeaturePrefix(
  claudeStorageId,
  projectPath,
  options.featurePrefix
);
const runId = await resolveRunId(claudeStorageId, projectPath, featurePrefix, options.runId);
const waitMs = options.waitMs ? Number(options.waitMs) : 0;
const name = options.name || "live-base";

const startedAt = new Date().toISOString();

await initBrowser({ baseUrl });

let navigationStatus: number | undefined;
let navigationTitle: string | undefined;
let navigationError: string | undefined;
let navigationSuccess = true;

try {
  const navResult = await navigate(baseUrl);
  navigationStatus = navResult.statusCode;
  navigationTitle = navResult.title;
  navigationSuccess = navResult.success;
  navigationError = navResult.error;

  if (waitMs > 0) {
    await wait(waitMs);
  }

  const buffer = await screenshot(name);
  const artifact = await saveScreenshot(
    buffer,
    undefined,
    claudeStorageId,
    featurePrefix
  );

  const completedAt = new Date().toISOString();
  const testResultArtifact = await saveTestResult(
    {
      type: "playwright_screenshot",
      baseUrl,
      featurePrefix,
      runId,
      startedAt,
      completedAt,
      screenshot: {
        id: artifact.id,
        path: artifact.path,
      },
      navigation: {
        success: navigationSuccess,
        statusCode: navigationStatus,
        title: navigationTitle,
        error: navigationError,
      },
    },
    undefined,
    claudeStorageId,
    featurePrefix
  );

  console.log(
    JSON.stringify(
      {
        ok: navigationSuccess,
        runId,
        screenshotId: artifact.id,
        testResultId: testResultArtifact.id,
      },
      null,
      2
    )
  );
} finally {
  await closeBrowser();
}

process.exitCode = navigationSuccess ? 0 : 1;
