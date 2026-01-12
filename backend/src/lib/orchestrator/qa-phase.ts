/**
 * QA Phase
 *
 * Interactive user interview to gather feature requirements.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  getPipeline,
  updatePhase,
  updateStatus,
  setRequirements,
  setEpics,
  addToConversation,
  appendEvent,
  setTargetProjectPath,
  markRunning,
  markStopped,
} from "../pipeline";
import {
  runPipelineAgent,
  runPipelineAgentWithMessage,
  type PipelineAgentResult,
} from "../agent";
import { createToolCallbacks, emitTodoEvents } from "./callbacks";
import { LOG, logPhase } from "./utils";
import {
  FLIGHTPATH_ROOT,
  parseRequirementsFromSpec,
  generateTargetProjectPath,
  initializeTargetProject,
} from "./project-init";
import { runHarness } from "../harness";

/**
 * Clear any existing feature spec files to prevent contamination
 * from previous pipelines.
 */
async function clearFeatureSpecs(): Promise<void> {
  const { readdir } = await import("node:fs/promises");

  const claudeDir = join(FLIGHTPATH_ROOT, ".claude");
  if (!existsSync(claudeDir)) return;

  try {
    const entries = await readdir(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "skills") {
        const specPath = join(claudeDir, entry.name, "feature-spec.v3.json");
        if (existsSync(specPath)) {
          unlinkSync(specPath);
          console.log(`[QA] Cleared stale feature-spec.v3.json from .claude/${entry.name}/`);
        }
      }
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Run the QA phase - interview user about the feature
 * This phase is interactive and requires user input
 */
export async function runQAPhase(
  pipelineId: string,
  initialPrompt: string,
  targetProjectPath?: string
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  markRunning(pipelineId);

  console.log(`${LOG.qa} Starting QA phase for pipeline ${pipelineId.slice(0, 8)}`);
  await clearFeatureSpecs();
  appendEvent(pipelineId, "qa_started", { initialPrompt });
  updatePhase(pipelineId, { current: "qa" });

  // Start the QA agent with the initial prompt
  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", { content: chunk, streaming: true });
  };

  // Create tool callbacks for verbose logging
  const toolCallbacks = createToolCallbacks(pipelineId, "qa");

  try {
    logPhase("qa", "Starting QA agent", initialPrompt.slice(0, 100));
    appendEvent(pipelineId, "status_update", { action: "Starting feature discovery...", phase: "qa" });

    const result = await runPipelineAgent("feature-qa", initialPrompt, onStreamChunk, targetProjectPath, 50, toolCallbacks);

    // Emit todo events if agent returned todos in structured output
    emitTodoEvents(pipelineId, "qa", result.structuredOutput);

    logPhase("qa", "Agent responded", result.reply.slice(0, 100));

    // Store conversation history
    addToConversation(pipelineId, "user", initialPrompt);
    addToConversation(pipelineId, "assistant", result.reply);

    // Emit the full response
    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestion: result.userQuestion,
      userQuestions: result.userQuestions,
    });

    // If agent needs user input, pause and wait for message
    if (result.requiresUserInput) {
      // Pipeline will continue when user sends a message via handleUserMessage
      // Mark as stopped since we're waiting for user input
      markStopped(pipelineId);
      return;
    }

    // Check if QA is complete (agent should have written feature-spec.v3.json)
    if (isQAComplete(result)) {
      // Note: onQAComplete calls runHarness which has its own markRunning
      markStopped(pipelineId);
      await onQAComplete(pipelineId, result);
    } else {
      markStopped(pipelineId);
    }
  } catch (error) {
    markStopped(pipelineId);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Pipeline ${pipelineId}] QA phase failed:`, errorMessage);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    appendEvent(pipelineId, "pipeline_failed", {
      phase: "qa",
      error: errorMessage,
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

  markRunning(pipelineId);

  appendEvent(pipelineId, "user_message", { content: message });
  addToConversation(pipelineId, "user", message);

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", { content: chunk, streaming: true });
  };

  const toolCallbacks = createToolCallbacks(pipelineId, "qa");

  try {
    logPhase("qa", "Continuing QA with user message", message.slice(0, 50));
    console.log(`[QA Debug] Conversation history length: ${pipeline.conversationHistory.length}`);
    // Count user messages to show progress (each user message = 1 exchange)
    const exchangeCount = pipeline.conversationHistory.filter(m => m.role === "user").length;
    // Provide immediate feedback that the agent is working
    appendEvent(pipelineId, "status_update", {
      action: `Processing response ${exchangeCount} (this may take a few minutes if generating requirements)...`,
      phase: "qa"
    });

    console.log(`[QA Debug] Calling runPipelineAgentWithMessage...`);
    const result = await runPipelineAgentWithMessage(
      "feature-qa",
      message,
      pipeline.conversationHistory,
      onStreamChunk,
      pipeline.targetProjectPath,
      50,
      toolCallbacks
    );
    console.log(`[QA Debug] runPipelineAgentWithMessage returned, requiresUserInput=${result.requiresUserInput}`);

    // Emit todo events if agent returned todos in structured output
    emitTodoEvents(pipelineId, "qa", result.structuredOutput);

    addToConversation(pipelineId, "assistant", result.reply);

    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestion: result.userQuestion,
      userQuestions: result.userQuestions,
    });

    // Check if QA is complete
    if (isQAComplete(result)) {
      // Note: onQAComplete calls runHarness which has its own markRunning
      markStopped(pipelineId);
      await onQAComplete(pipelineId, result);
    } else {
      // Waiting for more user input
      markStopped(pipelineId);
    }
  } catch (error) {
    markStopped(pipelineId);
    appendEvent(pipelineId, "pipeline_failed", {
      phase: "qa",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    updateStatus(pipelineId, "failed");
  }
}

/**
 * Find if any feature spec file exists in .claude/{prefix}/ folders
 */
function findExistingSpecPath(): string | null {
  const { readdirSync } = require("node:fs");

  const claudeDir = join(FLIGHTPATH_ROOT, ".claude");
  if (!existsSync(claudeDir)) return null;

  try {
    const entries = readdirSync(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "skills") {
        const specPath = join(claudeDir, entry.name, "feature-spec.v3.json");
        if (existsSync(specPath)) {
          return specPath;
        }
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Check if QA phase is complete
 * Uses file-based detection for reliability instead of string matching.
 */
function isQAComplete(result: PipelineAgentResult): boolean {
  // Primary: Check if agent wrote to the spec file via tool calls
  const wroteSpecFile = result.toolCalls?.some(
    (call) =>
      call.name === "Write" &&
      String((call.args as Record<string, unknown>)?.file_path || "").includes("feature-spec.v3.json")
  );

  if (wroteSpecFile) {
    console.log(`${LOG.qa} Checking completion... result=true (spec file written by agent)`);
    return true;
  }

  // Fallback: Check actual file existence in any .claude/{prefix}/ folder
  const specPath = findExistingSpecPath();

  if (specPath) {
    console.log(`${LOG.qa} Checking completion... result=true (spec file exists at ${specPath})`);
    return true;
  }

  console.log(`${LOG.qa} Checking completion... result=false (no spec file)`);
  return false;
}

/**
 * Handle QA completion - parse requirements and start the loop
 */
async function onQAComplete(
  pipelineId: string,
  _result: PipelineAgentResult
): Promise<void> {
  appendEvent(pipelineId, "qa_completed", {});
  appendEvent(pipelineId, "requirements_ready", {
    message: "Requirements have been generated",
  });

  // Parse requirements, epics, project name, and feature prefix from the feature spec
  const { requirements, epics, projectName, featurePrefix } = await parseRequirementsFromSpec();

  console.log(`${LOG.qa} Complete. Found ${requirements.length} requirements, ${epics.length} epics, project: ${projectName}, prefix: ${featurePrefix}`);

  if (requirements.length === 0) {
    appendEvent(pipelineId, "pipeline_failed", {
      error: "No requirements found after QA phase",
    });
    updateStatus(pipelineId, "failed");
    return;
  }

  // Generate and set the target project path
  const targetPath = generateTargetProjectPath(projectName);
  setTargetProjectPath(pipelineId, targetPath);

  // Create target directory and copy feature spec
  await initializeTargetProject(targetPath, featurePrefix);

  appendEvent(pipelineId, "target_project_set", {
    projectName,
    targetPath,
  });

  setRequirements(pipelineId, requirements);
  setEpics(pipelineId, epics);
  updatePhase(pipelineId, { totalRequirements: requirements.length });

  // Start the harness with autonomous agent
  await runHarness({
    pipelineId,
    requirements,
    targetProjectPath: targetPath,
    model: "opus",
    maxTurns: 500,
    enablePlaywright: true,
  });
}
