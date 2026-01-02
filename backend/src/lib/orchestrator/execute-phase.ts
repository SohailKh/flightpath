/**
 * Execute Phase
 *
 * Implements code changes for a requirement.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  type Requirement,
  getPipeline,
  updatePhase,
  updateStatus,
  appendEvent,
  addArtifact,
} from "../pipeline";
import { runPipelineAgent } from "../agent";
import { type MergedExplorationContext } from "../model-selector";
import { saveDiff } from "../artifacts";
import { createToolCallbacks, emitTodoEvents } from "./callbacks";
import { logPhase } from "./utils";

const execAsync = promisify(exec);

export interface ExecutePhaseOptions {
  explorationContext?: MergedExplorationContext;
  modelOverride?: string;
}

/**
 * Run the execution phase for a requirement
 */
export async function runExecutePhase(
  pipelineId: string,
  requirement: Requirement,
  options: ExecutePhaseOptions = {}
): Promise<void> {
  const { explorationContext, modelOverride } = options;
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  logPhase("execute", `Starting execution for ${requirement.id}`, requirement.title);

  appendEvent(pipelineId, "executing_started", {
    requirementId: requirement.id,
  });
  updatePhase(pipelineId, { current: "executing" });
  updateStatus(pipelineId, "executing");

  // Build exploration context section if available
  const contextSection = explorationContext ? `## Exploration Context
Patterns: ${explorationContext.patterns.map(p => p.name).join(', ') || 'none'}
Related templates: ${explorationContext.relatedFiles.templates.join(', ') || 'none'}
Related types: ${explorationContext.relatedFiles.types.join(', ') || 'none'}
Related tests: ${explorationContext.relatedFiles.tests.join(', ') || 'none'}
API endpoints: ${explorationContext.apiEndpoints.join(', ') || 'none'}
Notes: ${explorationContext.notes.join('\n') || 'none'}

` : '';

  const prompt = `${contextSection}Execute the implementation for requirement: ${requirement.id}

Follow the plan in current-feature.json and implement the code changes.`;

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", {
      phase: "executing",
      content: chunk,
      streaming: true,
    });
  };

  const toolCallbacks = createToolCallbacks(pipelineId, "executing");
  appendEvent(pipelineId, "status_update", { action: "Implementing code changes...", phase: "executing" });

  const result = await runPipelineAgent(
    "feature-executor",
    prompt,
    onStreamChunk,
    pipeline.targetProjectPath,
    undefined,
    toolCallbacks,
    undefined, // playwrightAgentOptions
    modelOverride
  );

  // Emit todo events if agent returned todos in structured output
  emitTodoEvents(pipelineId, "executing", result.structuredOutput);

  logPhase("execute", "Execution completed", `${requirement.id}`);

  appendEvent(pipelineId, "agent_message", {
    phase: "executing",
    content: result.reply,
    streaming: false,
  });

  // Capture diff after execution
  await captureDiff(pipelineId, requirement.id, pipeline.targetProjectPath);

  appendEvent(pipelineId, "executing_completed", {
    requirementId: requirement.id,
  });
}

/**
 * Capture git diff and save as artifact
 */
async function captureDiff(
  pipelineId: string,
  requirementId: string,
  targetProjectPath?: string
): Promise<void> {
  if (!targetProjectPath) return;

  try {
    // Get the diff of uncommitted changes
    const { stdout } = await execAsync("git diff HEAD", {
      cwd: targetProjectPath,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });

    if (stdout.trim()) {
      const artifact = await saveDiff(
        stdout,
        requirementId,
        targetProjectPath
      );
      addArtifact(pipelineId, {
        id: artifact.id,
        type: artifact.type,
        path: artifact.path,
        requirementId,
      });
      logPhase("execute", "Saved diff artifact", artifact.id);
    } else {
      logPhase("execute", "No diff to capture", "working tree clean");
    }
  } catch (err) {
    // Git might not be initialized or no commits yet - this is OK
    logPhase("error", "Failed to capture diff", String(err));
  }
}
