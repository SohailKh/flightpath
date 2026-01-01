/**
 * Playwright Step Executor
 *
 * Parses and executes smoke test step prefixes using Playwright tools.
 * Maps step prefix syntax to Playwright actions.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  navigate,
  click,
  type,
  fill,
  screenshot,
  assertVisible,
  assertText,
  wait,
  httpRequest,
} from "./playwright-tools";
import { parseStep } from "./playwright-selector";
import type {
  StepExecutionResult,
  ParsedStep,
  PlaywrightActionResult,
  Evidence,
} from "./playwright-types";

/**
 * Get evidence directory for a run
 */
function getEvidenceDir(runId: string, projectPath?: string): string {
  const base = projectPath || process.cwd();
  return join(base, ".claude", "features", "runs", runId, "evidence");
}

/**
 * Ensure evidence directory exists
 */
async function ensureEvidenceDir(runId: string, projectPath?: string): Promise<string> {
  const dir = getEvidenceDir(runId, projectPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Save screenshot evidence
 */
async function saveScreenshotEvidence(
  buffer: Buffer,
  name: string,
  runId: string,
  projectPath?: string
): Promise<Evidence> {
  const dir = await ensureEvidenceDir(runId, projectPath);
  const filename = `${name.replace(/[^a-zA-Z0-9-_]/g, "-")}.png`;
  const filepath = join(dir, filename);
  await writeFile(filepath, buffer);

  return {
    type: "screenshot",
    path: `.claude/features/runs/${runId}/evidence/${filename}`,
    description: `Screenshot: ${name}`,
  };
}

/**
 * Save API response evidence
 */
async function saveApiResponseEvidence(
  response: string,
  name: string,
  runId: string,
  projectPath?: string
): Promise<Evidence> {
  const dir = await ensureEvidenceDir(runId, projectPath);
  const filename = `${name.replace(/[^a-zA-Z0-9-_]/g, "-")}.json`;
  const filepath = join(dir, filename);
  await writeFile(filepath, response);

  return {
    type: "api-response",
    path: `.claude/features/runs/${runId}/evidence/${filename}`,
    description: `API Response: ${name}`,
  };
}

/**
 * Execute a parsed step
 */
async function executeParsedStep(
  parsed: ParsedStep,
  runId: string,
  stepIndex: number,
  projectPath?: string
): Promise<{ result: PlaywrightActionResult; evidence?: Evidence }> {
  let result: PlaywrightActionResult;
  let evidence: Evidence | undefined;

  switch (parsed.action) {
    case "navigate": {
      if (!parsed.url) {
        result = {
          success: false,
          action: "navigate",
          duration: 0,
          error: "Missing url parameter for navigate step",
        };
        break;
      }
      result = await navigate(parsed.url);
      break;
    }

    case "tap":
    case "click": {
      if (!parsed.selector) {
        result = {
          success: false,
          action: "click",
          duration: 0,
          error: "Missing selector for tap/click step",
        };
        break;
      }
      result = await click(parsed.selector, { captureEvidence: true });

      // Save post-click screenshot as evidence
      if (result.success && result.screenshot) {
        evidence = await saveScreenshotEvidence(
          result.screenshot,
          `step-${stepIndex}-click`,
          runId,
          projectPath
        );
      }
      break;
    }

    case "type": {
      if (!parsed.selector || !parsed.value) {
        result = {
          success: false,
          action: "type",
          duration: 0,
          error: "Missing selector or value for type step",
        };
        break;
      }
      result = await type(parsed.selector, parsed.value);
      break;
    }

    case "fill": {
      if (!parsed.selector || !parsed.value) {
        result = {
          success: false,
          action: "fill",
          duration: 0,
          error: "Missing selector or value for fill step",
        };
        break;
      }
      result = await fill(parsed.selector, parsed.value);
      break;
    }

    case "assertVisible": {
      if (!parsed.selector) {
        result = {
          success: false,
          action: "assertVisible",
          duration: 0,
          error: "Missing selector for assertVisible step",
        };
        break;
      }
      const assertResult = await assertVisible(parsed.selector);
      result = assertResult;

      // Save screenshot as evidence
      if (assertResult.screenshot) {
        evidence = await saveScreenshotEvidence(
          assertResult.screenshot,
          `step-${stepIndex}-assertVisible`,
          runId,
          projectPath
        );
      }
      break;
    }

    case "assertText": {
      if (!parsed.selector || !parsed.expected) {
        result = {
          success: false,
          action: "assertText",
          duration: 0,
          error: "Missing selector or expected text for assertText step",
        };
        break;
      }
      result = await assertText(parsed.selector, parsed.expected);
      break;
    }

    case "screenshot": {
      const name = parsed.name || `step-${stepIndex}`;
      const screenshotBuf = await screenshot(name);

      evidence = await saveScreenshotEvidence(
        screenshotBuf,
        name,
        runId,
        projectPath
      );

      result = {
        success: true,
        action: "screenshot",
        screenshot: screenshotBuf,
        duration: 0,
        metadata: { name },
      };
      break;
    }

    case "wait": {
      if (!parsed.ms) {
        result = {
          success: false,
          action: "wait",
          duration: 0,
          error: "Missing ms parameter for wait step",
        };
        break;
      }
      result = await wait(parsed.ms);
      break;
    }

    case "curl": {
      if (!parsed.method || !parsed.url) {
        result = {
          success: false,
          action: "httpRequest",
          duration: 0,
          error: "Missing method or url for curl step",
        };
        break;
      }
      const httpResult = await httpRequest(parsed.method, parsed.url, {
        expectStatus: parsed.expectStatus,
      });
      result = httpResult;

      // Save API response as evidence
      if ("responseBody" in httpResult && httpResult.responseBody) {
        evidence = await saveApiResponseEvidence(
          httpResult.responseBody,
          `step-${stepIndex}-api`,
          runId,
          projectPath
        );
      }
      break;
    }

    default:
      result = {
        success: false,
        action: parsed.action,
        duration: 0,
        error: `Unknown step action: ${parsed.action}`,
      };
  }

  return { result, evidence };
}

/**
 * Execute a single smoke test step
 *
 * @param step - Raw step string (e.g., "tap:testId=submit-btn")
 * @param runId - Run ID for evidence storage
 * @param stepIndex - Index in the step sequence
 * @param projectPath - Optional project root path
 * @returns Step execution result with evidence
 */
export async function executeStep(
  step: string,
  runId: string,
  stepIndex: number,
  projectPath?: string
): Promise<StepExecutionResult> {
  // Parse the step
  const parsed = parseStep(step);

  // Extract step prefix for result
  const stepPrefix = parsed.action;

  // Execute the parsed step
  const { result, evidence } = await executeParsedStep(
    parsed,
    runId,
    stepIndex,
    projectPath
  );

  return {
    stepIndex,
    stepPrefix,
    rawStep: step,
    result,
    evidence,
  };
}

/**
 * Execute a sequence of smoke test steps
 *
 * @param steps - Array of step strings
 * @param runId - Run ID for evidence storage
 * @param projectPath - Optional project root path
 * @param onStepComplete - Optional callback after each step
 * @returns Array of step execution results
 */
export async function executeSteps(
  steps: string[],
  runId: string,
  projectPath?: string,
  onStepComplete?: (result: StepExecutionResult) => void
): Promise<StepExecutionResult[]> {
  const results: StepExecutionResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const result = await executeStep(step, runId, i, projectPath);
    results.push(result);

    // Notify callback
    onStepComplete?.(result);

    // Stop on failure
    if (!result.result.success) {
      break;
    }
  }

  return results;
}

/**
 * Execute steps and return summary
 */
export async function executeStepsWithSummary(
  steps: string[],
  runId: string,
  projectPath?: string
): Promise<{
  passed: boolean;
  results: StepExecutionResult[];
  failedAtStep: number | null;
  evidence: Evidence[];
  summary: string;
}> {
  const results = await executeSteps(steps, runId, projectPath);

  const evidence: Evidence[] = results
    .filter((r) => r.evidence)
    .map((r) => r.evidence!);

  const failedStep = results.find((r) => !r.result.success);
  const passed = !failedStep;

  let summary: string;
  if (passed) {
    summary = `All ${results.length} steps passed`;
  } else {
    const failedIndex = failedStep!.stepIndex;
    summary = `Failed at step ${failedIndex + 1}/${steps.length}: ${failedStep!.rawStep} - ${failedStep!.result.error}`;
  }

  return {
    passed,
    results,
    failedAtStep: failedStep ? failedStep.stepIndex : null,
    evidence,
    summary,
  };
}
