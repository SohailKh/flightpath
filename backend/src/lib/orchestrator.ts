/**
 * Pipeline Orchestrator
 *
 * Manages the full workflow: QA → (Plan → Execute → Test) loop
 * Handles agent chaining, retry logic, and abort/pause controls.
 */

import {
  type Pipeline,
  type Requirement,
  getPipeline,
  updatePhase,
  updateStatus,
  setRequirements,
  updateRequirement,
  addToConversation,
  addArtifact,
  appendEvent,
  isPauseRequested,
  isAbortRequested,
} from "./pipeline";
import {
  runPipelineAgent,
  runPipelineAgentWithMessage,
  type ConversationMessage,
  type PipelineAgentResult,
} from "./agent";
import { saveScreenshot, saveTestResult, saveDiff } from "./artifacts";

const MAX_RETRIES = 3;

/**
 * Check abort/pause status and handle accordingly
 * Returns true if pipeline should stop
 */
async function checkControlFlags(pipelineId: string): Promise<boolean> {
  if (isAbortRequested(pipelineId)) {
    updateStatus(pipelineId, "aborted");
    appendEvent(pipelineId, "aborted", {});
    return true;
  }

  if (isPauseRequested(pipelineId)) {
    updateStatus(pipelineId, "paused");
    appendEvent(pipelineId, "paused", {});
    return true;
  }

  return false;
}

/**
 * Run the QA phase - interview user about the feature
 * This phase is interactive and requires user input
 */
export async function runQAPhase(
  pipelineId: string,
  initialPrompt: string
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  appendEvent(pipelineId, "qa_started", { initialPrompt });
  updatePhase(pipelineId, { current: "qa" });

  // Start the QA agent with the initial prompt
  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", { content: chunk, streaming: true });
  };

  try {
    const result = await runPipelineAgent("feature-qa", initialPrompt, onStreamChunk);

    // Store conversation history
    addToConversation(pipelineId, "user", initialPrompt);
    addToConversation(pipelineId, "assistant", result.reply);

    // Emit the full response
    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestion: result.userQuestion,
    });

    // If agent needs user input, pause and wait for message
    if (result.requiresUserInput) {
      // Pipeline will continue when user sends a message via handleUserMessage
      return;
    }

    // Check if QA is complete (agent should have written feature-spec.v3.json)
    if (isQAComplete(result)) {
      await onQAComplete(pipelineId, result);
    }
  } catch (error) {
    appendEvent(pipelineId, "pipeline_failed", {
      phase: "qa",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    updateStatus(pipelineId, "failed");
  }
}

/**
 * Handle user message during QA phase
 */
export async function handleUserMessage(
  pipelineId: string,
  message: string
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  // Only allow messages during QA phase
  if (pipeline.phase.current !== "qa") {
    appendEvent(pipelineId, "user_message", {
      content: message,
      error: "User messages only allowed during QA phase",
    });
    return;
  }

  appendEvent(pipelineId, "user_message", { content: message });
  addToConversation(pipelineId, "user", message);

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", { content: chunk, streaming: true });
  };

  try {
    const result = await runPipelineAgentWithMessage(
      "feature-qa",
      message,
      pipeline.conversationHistory,
      onStreamChunk
    );

    addToConversation(pipelineId, "assistant", result.reply);

    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestion: result.userQuestion,
    });

    // Check if QA is complete
    if (isQAComplete(result)) {
      await onQAComplete(pipelineId, result);
    }
  } catch (error) {
    appendEvent(pipelineId, "pipeline_failed", {
      phase: "qa",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    updateStatus(pipelineId, "failed");
  }
}

/**
 * Check if QA phase is complete
 * The QA agent signals completion by invoking feature-init
 */
function isQAComplete(result: PipelineAgentResult): boolean {
  // Check if the agent output indicates requirements are ready
  // This could be detected by:
  // 1. Agent explicitly stating requirements are ready
  // 2. Agent attempting to chain to feature-init
  // 3. Detection of feature-spec.v3.json being written

  const reply = result.reply.toLowerCase();
  return (
    reply.includes("requirements have been generated") ||
    reply.includes("use feature-init") ||
    reply.includes("feature-spec.v3.json") ||
    !result.requiresUserInput
  );
}

/**
 * Handle QA completion - parse requirements and start the loop
 */
async function onQAComplete(
  pipelineId: string,
  result: PipelineAgentResult
): Promise<void> {
  appendEvent(pipelineId, "qa_completed", {});
  appendEvent(pipelineId, "requirements_ready", {
    message: "Requirements have been generated",
  });

  // In a real implementation, we would read the requirements from
  // .claude/features/feature-spec.v3.json here
  // For now, we'll use placeholder requirements
  const requirements = await parseRequirementsFromSpec();

  if (requirements.length === 0) {
    appendEvent(pipelineId, "pipeline_failed", {
      error: "No requirements found after QA phase",
    });
    updateStatus(pipelineId, "failed");
    return;
  }

  setRequirements(pipelineId, requirements);
  updatePhase(pipelineId, { totalRequirements: requirements.length });

  // Start the implementation loop
  await runImplementationLoop(pipelineId);
}

/**
 * Parse requirements from the feature spec file
 */
async function parseRequirementsFromSpec(): Promise<Requirement[]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");

    const specPath = join(
      process.cwd(),
      ".claude",
      "features",
      "feature-spec.v3.json"
    );

    if (!existsSync(specPath)) {
      console.warn("Feature spec not found:", specPath);
      return [];
    }

    const content = await readFile(specPath, "utf-8");
    const spec = JSON.parse(content);

    if (!spec.requirements || !Array.isArray(spec.requirements)) {
      return [];
    }

    return spec.requirements.map(
      (req: Record<string, unknown>): Requirement => ({
        id: String(req.id || ""),
        title: String(req.title || ""),
        description: String(req.description || ""),
        priority: Number(req.priority || 0),
        status: "pending",
        acceptanceCriteria: Array.isArray(req.acceptanceCriteria)
          ? req.acceptanceCriteria.map(String)
          : [],
      })
    );
  } catch (error) {
    console.error("Error parsing requirements:", error);
    return [];
  }
}

/**
 * Run the main implementation loop: Plan → Execute → Test for each requirement
 */
async function runImplementationLoop(pipelineId: string): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  for (let i = 0; i < pipeline.requirements.length; i++) {
    // Check control flags at the start of each requirement
    if (await checkControlFlags(pipelineId)) {
      return;
    }

    const requirement = pipeline.requirements[i];
    updatePhase(pipelineId, { requirementIndex: i, retryCount: 0 });

    appendEvent(pipelineId, "requirement_started", {
      requirementId: requirement.id,
      title: requirement.title,
      index: i,
      total: pipeline.requirements.length,
    });

    updateRequirement(pipelineId, requirement.id, "in_progress");

    // Run plan → execute → test with retry logic
    let success = false;
    let retryCount = 0;

    while (!success && retryCount < MAX_RETRIES) {
      if (await checkControlFlags(pipelineId)) {
        return;
      }

      try {
        // PLAN phase
        await runPlanPhase(pipelineId, requirement);
        if (await checkControlFlags(pipelineId)) return;

        // EXECUTE phase
        await runExecutePhase(pipelineId, requirement);
        if (await checkControlFlags(pipelineId)) return;

        // TEST phase
        const testPassed = await runTestPhase(pipelineId, requirement);

        if (testPassed) {
          success = true;
          updateRequirement(pipelineId, requirement.id, "completed");
          appendEvent(pipelineId, "requirement_completed", {
            requirementId: requirement.id,
          });
        } else {
          retryCount++;
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
        retryCount++;
        updatePhase(pipelineId, { retryCount });

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        if (retryCount >= MAX_RETRIES) {
          appendEvent(pipelineId, "requirement_failed", {
            requirementId: requirement.id,
            error: errorMessage,
            attempts: retryCount,
          });
          updateRequirement(pipelineId, requirement.id, "failed");
        } else {
          appendEvent(pipelineId, "retry_started", {
            requirementId: requirement.id,
            attempt: retryCount + 1,
            maxAttempts: MAX_RETRIES,
            error: errorMessage,
          });
        }
      }
    }

    if (!success) {
      // Requirement failed after all retries - continue to next
      updateRequirement(pipelineId, requirement.id, "failed");
    }
  }

  // All requirements processed
  appendEvent(pipelineId, "pipeline_completed", {
    totalRequirements: pipeline.requirements.length,
    completed: pipeline.requirements.filter((r) => r.status === "completed")
      .length,
    failed: pipeline.requirements.filter((r) => r.status === "failed").length,
  });
  updateStatus(pipelineId, "completed");
}

/**
 * Run the planning phase for a requirement
 */
async function runPlanPhase(
  pipelineId: string,
  requirement: Requirement
): Promise<void> {
  appendEvent(pipelineId, "planning_started", {
    requirementId: requirement.id,
  });
  updatePhase(pipelineId, { current: "planning" });
  updateStatus(pipelineId, "planning");

  const prompt = `Plan the implementation for requirement: ${requirement.id}

Title: ${requirement.title}
Description: ${requirement.description}

Acceptance Criteria:
${requirement.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

Create a detailed implementation plan following the feature-planner guidelines.`;

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", {
      phase: "planning",
      content: chunk,
      streaming: true,
    });
  };

  const result = await runPipelineAgent("feature-planner", prompt, onStreamChunk);

  appendEvent(pipelineId, "agent_message", {
    phase: "planning",
    content: result.reply,
    streaming: false,
  });

  appendEvent(pipelineId, "planning_completed", {
    requirementId: requirement.id,
  });
}

/**
 * Run the execution phase for a requirement
 */
async function runExecutePhase(
  pipelineId: string,
  requirement: Requirement
): Promise<void> {
  appendEvent(pipelineId, "executing_started", {
    requirementId: requirement.id,
  });
  updatePhase(pipelineId, { current: "executing" });
  updateStatus(pipelineId, "executing");

  const prompt = `Execute the implementation for requirement: ${requirement.id}

Follow the plan in current-feature.json and implement the code changes.`;

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", {
      phase: "executing",
      content: chunk,
      streaming: true,
    });
  };

  const result = await runPipelineAgent("feature-executor", prompt, onStreamChunk);

  appendEvent(pipelineId, "agent_message", {
    phase: "executing",
    content: result.reply,
    streaming: false,
  });

  appendEvent(pipelineId, "executing_completed", {
    requirementId: requirement.id,
  });
}

/**
 * Run the testing phase for a requirement
 * Returns true if tests passed
 */
async function runTestPhase(
  pipelineId: string,
  requirement: Requirement
): Promise<boolean> {
  appendEvent(pipelineId, "testing_started", {
    requirementId: requirement.id,
  });
  updatePhase(pipelineId, { current: "testing" });
  updateStatus(pipelineId, "testing");

  const prompt = `Test the implementation for requirement: ${requirement.id}

Verify all acceptance criteria:
${requirement.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

Run tests and capture screenshots as evidence.`;

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", {
      phase: "testing",
      content: chunk,
      streaming: true,
    });
  };

  const result = await runPipelineAgent("feature-tester", prompt, onStreamChunk);

  appendEvent(pipelineId, "agent_message", {
    phase: "testing",
    content: result.reply,
    streaming: false,
  });

  // Determine if tests passed based on agent output
  const testPassed = determineTestResult(result);

  if (testPassed) {
    appendEvent(pipelineId, "test_passed", {
      requirementId: requirement.id,
    });
  } else {
    appendEvent(pipelineId, "test_failed", {
      requirementId: requirement.id,
      reason: extractFailureReason(result),
    });
  }

  appendEvent(pipelineId, "testing_completed", {
    requirementId: requirement.id,
    passed: testPassed,
  });

  return testPassed;
}

/**
 * Determine if tests passed based on agent result
 */
function determineTestResult(result: PipelineAgentResult): boolean {
  const reply = result.reply.toLowerCase();

  // Check for explicit success indicators
  if (
    reply.includes("all tests passed") ||
    reply.includes("tests passed") ||
    reply.includes("implementation verified") ||
    reply.includes("acceptance criteria met")
  ) {
    return true;
  }

  // Check for failure indicators
  if (
    reply.includes("test failed") ||
    reply.includes("tests failed") ||
    reply.includes("acceptance criteria not met") ||
    reply.includes("issues found")
  ) {
    return false;
  }

  // Default to passed if no clear indicator
  return true;
}

/**
 * Extract failure reason from test result
 */
function extractFailureReason(result: PipelineAgentResult): string {
  const reply = result.reply;

  // Look for common failure patterns
  const failurePatterns = [
    /failed:?\s*(.+?)(?:\n|$)/i,
    /error:?\s*(.+?)(?:\n|$)/i,
    /issue:?\s*(.+?)(?:\n|$)/i,
  ];

  for (const pattern of failurePatterns) {
    const match = reply.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return "Unknown failure reason";
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
    case "planning":
    case "executing":
    case "testing":
      // Resume implementation loop
      await runImplementationLoop(pipelineId);
      break;
  }
}
