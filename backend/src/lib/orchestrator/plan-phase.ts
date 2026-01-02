/**
 * Plan Phase
 *
 * Creates implementation plan for a requirement.
 */

import {
  type Requirement,
  getPipeline,
  updatePhase,
  updateStatus,
  appendEvent,
} from "../pipeline";
import { runPipelineAgent } from "../agent";
import { type MergedExplorationContext } from "../model-selector";
import { createToolCallbacks, emitTodoEvents } from "./callbacks";
import { logPhase } from "./utils";

export interface PlanPhaseOptions {
  explorationContext?: MergedExplorationContext;
  modelOverride?: string;
}

/**
 * Run the planning phase for a requirement
 */
export async function runPlanPhase(
  pipelineId: string,
  requirement: Requirement,
  options: PlanPhaseOptions = {}
): Promise<void> {
  const { explorationContext, modelOverride } = options;
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  logPhase("plan", `Starting planning for ${requirement.id}`, requirement.title);

  appendEvent(pipelineId, "planning_started", {
    requirementId: requirement.id,
  });
  updatePhase(pipelineId, { current: "planning" });
  updateStatus(pipelineId, "planning");

  // Build exploration context section if available
  const contextSection = explorationContext ? `## Exploration Context
Patterns: ${explorationContext.patterns.map(p => p.name).join(', ') || 'none'}
Related templates: ${explorationContext.relatedFiles.templates.join(', ') || 'none'}
Related types: ${explorationContext.relatedFiles.types.join(', ') || 'none'}
Related tests: ${explorationContext.relatedFiles.tests.join(', ') || 'none'}
API endpoints: ${explorationContext.apiEndpoints.join(', ') || 'none'}
Notes: ${explorationContext.notes.join('\n') || 'none'}

` : '';

  const prompt = `${contextSection}Plan the implementation for requirement: ${requirement.id}

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

  const toolCallbacks = createToolCallbacks(pipelineId, "planning");
  appendEvent(pipelineId, "status_update", { action: "Analyzing requirements...", phase: "planning" });

  const result = await runPipelineAgent(
    "feature-planner",
    prompt,
    onStreamChunk,
    pipeline.targetProjectPath,
    undefined,
    toolCallbacks,
    undefined, // playwrightAgentOptions
    modelOverride
  );

  // Emit todo events if agent returned todos in structured output
  emitTodoEvents(pipelineId, "planning", result.structuredOutput);

  logPhase("plan", "Planning completed", `${requirement.id}`);

  appendEvent(pipelineId, "agent_message", {
    phase: "planning",
    content: result.reply,
    streaming: false,
  });

  appendEvent(pipelineId, "planning_completed", {
    requirementId: requirement.id,
  });
}
