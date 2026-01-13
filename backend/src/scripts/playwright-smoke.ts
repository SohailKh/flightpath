import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initBrowser, closeBrowser, screenshot } from "../lib/playwright-tools";
import { executeStepsWithSummary } from "../lib/playwright-step-executor";
import { saveScreenshot, saveTestResult } from "../lib/artifacts";

type SmokeTest = {
  id: string;
  title?: string;
  steps?: string[];
  global?: boolean;
  platform?: string;
  epicId?: string;
  enabledWhen?: {
    requirementCompleted?: string;
  };
};

type SmokeTestsFile = {
  smokeTests?: SmokeTest[];
};

type SmokeTestResult = {
  id: string;
  title: string;
  status: "passed" | "failed" | "skipped";
  skippedReason?: string;
  failedAtStep?: number | null;
  evidence: string[];
  notes?: string;
};

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

async function resolveFeaturePrefix(rootPath: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const claudeDir = join(rootPath, ".claude");
  if (!existsSync(claudeDir)) return "pipeline";
  const entries = await readdir(claudeDir, { withFileTypes: true });
  const candidates = entries.filter(
    (entry) => entry.isDirectory() && entry.name !== "skills"
  );
  for (const entry of candidates) {
    const specPath = join(claudeDir, entry.name, "feature-spec.v3.json");
    const smokePath = join(claudeDir, entry.name, "smoke-tests.json");
    if (existsSync(specPath) || existsSync(smokePath)) {
      return entry.name;
    }
  }
  return candidates[0]?.name ?? "pipeline";
}

async function resolveRunId(
  rootPath: string,
  featurePrefix: string,
  explicit?: string
): Promise<string> {
  if (explicit) return explicit;
  const currentFeaturePath = join(
    rootPath,
    ".claude",
    featurePrefix,
    "current-feature.json"
  );
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

async function loadDependencyIndex(
  rootPath: string,
  featurePrefix: string
): Promise<Record<string, string> | null> {
  const indexPath = join(
    rootPath,
    ".claude",
    featurePrefix,
    "dependency-index.json"
  );
  if (!existsSync(indexPath)) return null;
  try {
    const content = await readFile(indexPath, "utf-8");
    const parsed = JSON.parse(content) as { index?: Record<string, string> };
    if (parsed && typeof parsed === "object") {
      if (parsed.index && typeof parsed.index === "object") {
        return parsed.index;
      }
      return parsed as Record<string, string>;
    }
  } catch {
    return null;
  }
  return null;
}

function isTestEnabled(
  test: SmokeTest,
  index: Record<string, string> | null
): boolean {
  const required = test.enabledWhen?.requirementCompleted;
  if (!required) return true;
  if (!index) return false;
  return index[required] === "completed";
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
const featurePrefix = await resolveFeaturePrefix(
  projectPath,
  options.featurePrefix
);
const runId = await resolveRunId(projectPath, featurePrefix, options.runId);

const smokePath = join(
  projectPath,
  ".claude",
  featurePrefix,
  "smoke-tests.json"
);

if (!existsSync(smokePath)) {
  console.log(`Smoke tests not configured at ${smokePath}.`);
  process.exit(0);
}

const smokeContent = await readFile(smokePath, "utf-8");
const smokeFile = JSON.parse(smokeContent) as SmokeTestsFile;
const smokeTests = smokeFile.smokeTests ?? [];
const requestedIds = options.testIds
  ? options.testIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  : null;
const selectedTests = requestedIds
  ? smokeTests.filter((test) => requestedIds.includes(test.id))
  : smokeTests;

if (selectedTests.length === 0) {
  console.log("No smoke tests found for the requested scope.");
  process.exit(0);
}

const dependencyIndex = await loadDependencyIndex(projectPath, featurePrefix);
const startedAt = new Date().toISOString();
const results: SmokeTestResult[] = [];
let hasFailures = false;

await initBrowser({ baseUrl });

try {
  for (const test of selectedTests) {
    const title = test.title ?? test.id;
    const steps = test.steps ?? [];
    if (!isTestEnabled(test, dependencyIndex)) {
      results.push({
        id: test.id,
        title,
        status: "skipped",
        skippedReason: "not enabled yet",
        failedAtStep: null,
        evidence: [],
      });
      continue;
    }

    if (steps.length === 0) {
      results.push({
        id: test.id,
        title,
        status: "skipped",
        skippedReason: "no steps defined",
        failedAtStep: null,
        evidence: [],
      });
      continue;
    }

    try {
      const summary = await executeStepsWithSummary(
        steps,
        projectPath,
        featurePrefix
      );

      const evidence = summary.evidence.map((item) => `${item.type}:${item.path}`);

      let screenshotFailed = false;
      try {
        const buffer = await screenshot(`smoke-${test.id}`);
        const artifact = await saveScreenshot(
          buffer,
          undefined,
          projectPath,
          featurePrefix
        );
        evidence.push(`screenshot:${artifact.path}`);
      } catch (error) {
        screenshotFailed = true;
        evidence.push(
          `screenshot:failed:${error instanceof Error ? error.message : String(error)}`
        );
      }

      const passed = summary.passed && !screenshotFailed;

      results.push({
        id: test.id,
        title,
        status: passed ? "passed" : "failed",
        failedAtStep: summary.failedAtStep,
        evidence,
        notes: summary.summary,
      });

      if (!passed) {
        hasFailures = true;
      }
    } catch (error) {
      results.push({
        id: test.id,
        title,
        status: "failed",
        failedAtStep: null,
        evidence: [],
        notes: error instanceof Error ? error.message : String(error),
      });
      hasFailures = true;
    }
  }
} finally {
  await closeBrowser();
}

const completedAt = new Date().toISOString();
const testResultArtifact = await saveTestResult(
  {
    type: "playwright_smoke",
    baseUrl,
    featurePrefix,
    runId,
    startedAt,
    completedAt,
    results,
  },
  undefined,
  projectPath,
  featurePrefix
);

console.log(
  JSON.stringify(
    {
      ok: !hasFailures,
      runId,
      artifactId: testResultArtifact.id,
      results,
    },
    null,
    2
  )
);

process.exitCode = hasFailures ? 1 : 0;
