/**
 * Playwright Step Executor
 *
 * Parses and executes smoke test step prefixes using Playwright tools.
 * Maps step prefix syntax to Playwright actions.
 */

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
import { saveScreenshot, saveArtifact } from "./artifacts";
import type {
  StepExecutionResult,
  ParsedStep,
  PlaywrightActionResult,
  Evidence,
} from "./playwright-types";

/**
 * Save screenshot evidence to artifacts folder
 */
async function saveScreenshotEvidence(
  buffer: Buffer,
  name: string,
  projectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<Evidence> {
  const artifact = await saveScreenshot(buffer, undefined, projectPath, featurePrefix);
  return {
    type: "screenshot",
    path: artifact.path,
    description: `Screenshot: ${name}`,
  };
}

/**
 * Save API response evidence to artifacts folder
 */
async function saveApiResponseEvidence(
  response: string,
  name: string,
  projectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<Evidence> {
  const artifact = await saveArtifact("test_result", response, undefined, projectPath, featurePrefix);
  return {
    type: "api-response",
    path: artifact.path,
    description: `API Response: ${name}`,
  };
}

/**
 * Execute a parsed step
 */
async function executeParsedStep(
  parsed: ParsedStep,
  stepIndex: number,
  projectPath?: string,
  featurePrefix: string = "pipeline"
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
    case "launchApp": {
      result = await navigate("/");
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
          projectPath,
          featurePrefix
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
          projectPath,
          featurePrefix
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
        projectPath,
        featurePrefix
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
          projectPath,
          featurePrefix
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
 * @param stepIndex - Index in the step sequence
 * @param projectPath - Optional project root path
 * @param featurePrefix - Feature prefix for artifact storage (default: "pipeline")
 * @returns Step execution result with evidence
 */
export async function executeStep(
  step: string,
  stepIndex: number,
  projectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<StepExecutionResult> {
  // Parse the step
  const parsed = parseStep(step);

  // Extract step prefix for result
  const stepPrefix = parsed.action;

  // Execute the parsed step
  const { result, evidence } = await executeParsedStep(
    parsed,
    stepIndex,
    projectPath,
    featurePrefix
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
 * @param projectPath - Optional project root path
 * @param featurePrefix - Feature prefix for artifact storage (default: "pipeline")
 * @param onStepComplete - Optional callback after each step
 * @returns Array of step execution results
 */
export async function executeSteps(
  steps: string[],
  projectPath?: string,
  featurePrefix: string = "pipeline",
  onStepComplete?: (result: StepExecutionResult) => void
): Promise<StepExecutionResult[]> {
  const results: StepExecutionResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const result = await executeStep(step, i, projectPath, featurePrefix);
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
  projectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<{
  passed: boolean;
  results: StepExecutionResult[];
  failedAtStep: number | null;
  evidence: Evidence[];
  summary: string;
}> {
  const results = await executeSteps(steps, projectPath, featurePrefix);

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
