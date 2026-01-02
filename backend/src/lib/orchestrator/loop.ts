/**
 * Implementation Loop
 *
 * Main orchestration loop that processes requirements through phases.
 */

import {
  getPipeline,
  updatePhase,
  updateStatus,
  updateRequirement,
  updateEpicProgress,
  appendEvent,
  isPauseRequested,
  isAbortRequested,
} from "../pipeline";
import { categorizeError } from "../parallel-explorer";
import { runExplorePhase } from "./explore-phase";
import { runPlanPhase } from "./plan-phase";
import { runExecutePhase } from "./execute-phase";
import { runTestPhase } from "./test-phase";
import { setImplementationLoopRunner } from "./qa-phase";
import { LOG } from "./utils";

const MAX_RETRIES = 3;

// Register this loop runner with qa-phase to avoid circular imports
setImplementationLoopRunner(runImplementationLoop);

/**
 * Check abort/pause status and handle accordingly
 * Returns true if pipeline should stop
 */
async function checkControlFlags(pipelineId: string): Promise<boolean> {
  const abort = isAbortRequested(pipelineId);
  const pause = isPauseRequested(pipelineId);

  if (abort || pause) {
    console.log(`${LOG.pipeline} Control check: abort=${abort}, pause=${pause}`);
  }

  if (abort) {
    updateStatus(pipelineId, "aborted");
    appendEvent(pipelineId, "aborted", {});
    return true;
  }

  if (pause) {
    updateStatus(pipelineId, "paused");
    appendEvent(pipelineId, "paused", {});
    return true;
  }

  return false;
}

/**
 * Run the main implementation loop: Explore → Plan → Execute → Test for each requirement
 */
export async function runImplementationLoop(pipelineId: string): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  console.log(`${LOG.pipeline} Starting implementation loop: ${pipeline.requirements.length} requirements`);

  for (let i = pipeline.phase.requirementIndex; i < pipeline.requirements.length; i++) {
    // Check control flags at the start of each requirement
    if (await checkControlFlags(pipelineId)) {
      return;
    }

    const requirement = pipeline.requirements[i];

    // Skip already completed or failed requirements
    if (requirement.status === "completed" || requirement.status === "failed") {
      console.log(`${LOG.pipeline} Skipping ${requirement.status} requirement ${i + 1}: ${requirement.title}`);
      continue;
    }

    console.log(`${LOG.pipeline} Requirement ${i + 1}/${pipeline.requirements.length}: ${requirement.title}`);
    updatePhase(pipelineId, { requirementIndex: i, retryCount: 0 });

    appendEvent(pipelineId, "requirement_started", {
      requirementId: requirement.id,
      title: requirement.title,
      index: i,
      total: pipeline.requirements.length,
    });

    updateRequirement(pipelineId, requirement.id, "in_progress");
    updateEpicProgress(pipelineId);

    // Run explore → plan → execute → test with retry logic
    let success = false;
    let retryCount = 0;

    while (!success && retryCount < MAX_RETRIES) {
      if (await checkControlFlags(pipelineId)) {
        return;
      }

      try {
        // EXPLORE phase
        const explorationResult = await runExplorePhase(pipelineId, requirement);
        if (await checkControlFlags(pipelineId)) return;

        // PLAN phase - pass exploration context and model override
        await runPlanPhase(pipelineId, requirement, {
          explorationContext: explorationResult.merged,
          modelOverride: explorationResult.selectedModel,
        });
        if (await checkControlFlags(pipelineId)) return;

        // EXECUTE phase - pass exploration context and model override
        await runExecutePhase(pipelineId, requirement, {
          explorationContext: explorationResult.merged,
          modelOverride: explorationResult.selectedModel,
        });
        if (await checkControlFlags(pipelineId)) return;

        // TEST phase
        const testPassed = await runTestPhase(pipelineId, requirement);

        if (testPassed) {
          success = true;
          console.log(`${LOG.pipeline} Requirement ${requirement.id} completed`);
          updateRequirement(pipelineId, requirement.id, "completed");
          updateEpicProgress(pipelineId);
          appendEvent(pipelineId, "requirement_completed", {
            requirementId: requirement.id,
          });
        } else {
          retryCount++;
          console.log(`${LOG.pipeline} Retry ${retryCount}/${MAX_RETRIES} for requirement ${requirement.id}`);
          updatePhase(pipelineId, { retryCount });

          if (retryCount < MAX_RETRIES) {
            appendEvent(pipelineId, "retry_started", {
              requirementId: requirement.id,
              attempt: retryCount + 1,
              maxAttempts: MAX_RETRIES,
            });
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        const errorType = categorizeError(errorMessage);

        console.log(`${LOG.error} Requirement ${requirement.id} error (${errorType}): ${errorMessage.slice(0, 100)}`);

        // Skip retries for configuration errors - they won't succeed without intervention
        if (errorType === "configuration") {
          console.log(`${LOG.pipeline} Configuration error detected - skipping retries for ${requirement.id}`);
          appendEvent(pipelineId, "requirement_failed", {
            requirementId: requirement.id,
            error: errorMessage,
            errorType,
            attempts: retryCount + 1,
            reason: "Configuration error - retry would not help",
          });
          updateRequirement(pipelineId, requirement.id, "failed");
          updateEpicProgress(pipelineId);
          break; // Exit retry loop for this requirement
        }

        retryCount++;
        updatePhase(pipelineId, { retryCount });

        if (retryCount >= MAX_RETRIES) {
          console.log(`${LOG.pipeline} Requirement ${requirement.id} failed after ${retryCount} attempts`);
          appendEvent(pipelineId, "requirement_failed", {
            requirementId: requirement.id,
            error: errorMessage,
            errorType,
            attempts: retryCount,
          });
          updateRequirement(pipelineId, requirement.id, "failed");
          updateEpicProgress(pipelineId);
        } else {
          console.log(`${LOG.pipeline} Retry ${retryCount}/${MAX_RETRIES} for requirement ${requirement.id} (error type: ${errorType})`);
          appendEvent(pipelineId, "retry_started", {
            requirementId: requirement.id,
            attempt: retryCount + 1,
            maxAttempts: MAX_RETRIES,
            error: errorMessage,
            errorType,
          });
        }
      }
    }

    if (!success) {
      // Requirement failed after all retries - continue to next
      updateRequirement(pipelineId, requirement.id, "failed");
      updateEpicProgress(pipelineId);
    }
  }

  // All requirements processed
  const completedCount = pipeline.requirements.filter((r) => r.status === "completed").length;
  const failedCount = pipeline.requirements.filter((r) => r.status === "failed").length;
  console.log(`${LOG.pipeline} Implementation complete: ${completedCount}/${pipeline.requirements.length} succeeded, ${failedCount} failed`);

  appendEvent(pipelineId, "pipeline_completed", {
    totalRequirements: pipeline.requirements.length,
    completed: completedCount,
    failed: failedCount,
  });
  updateStatus(pipelineId, "completed");
}

/**
 * Resume a paused pipeline
 */
export async function resumePipeline(pipelineId: string): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline || pipeline.status !== "paused") {
    return;
  }

  appendEvent(pipelineId, "resumed", {});

  // Resume from where we left off based on current phase
  switch (pipeline.phase.current) {
    case "qa":
      // QA phase - wait for user message
      break;
    case "exploring":
    case "planning":
    case "executing":
    case "testing":
      // Resume implementation loop
      await runImplementationLoop(pipelineId);
      break;
  }
}
