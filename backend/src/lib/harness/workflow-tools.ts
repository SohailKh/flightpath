/**
 * Workflow Tools
 *
 * Custom tools that the unified agent uses to signal state changes.
 * These are intercepted by the harness via SDK hooks and handled specially.
 */

import {
  updateRequirement,
  appendEvent,
  getPipeline,
  addCompletedRequirement,
  addFailedRequirement,
} from "../pipeline";
import type { EventBridge } from "./event-bridge";

/**
 * Workflow tool definitions for prompt injection
 */
export const WORKFLOW_TOOL_DEFINITIONS = `
## Workflow Tools (REQUIRED)

You MUST use these tools to signal your progress. The harness tracks requirements through these tools.

### start_requirement
Call when you begin working on a requirement.
- \`requirementId\`: string - The requirement ID from the requirements list
- \`approach\`: string - Brief description of your planned approach

### complete_requirement
Call when a requirement is fully implemented and verified.
- \`requirementId\`: string - The requirement ID
- \`summary\`: string - Brief summary of what was done
- \`filesModified\`: string[] - List of files that were created or modified

### fail_requirement
Call when a requirement cannot be completed (after reasonable attempts).
- \`requirementId\`: string - The requirement ID
- \`reason\`: string - Why it cannot be completed
- \`blockedBy\`: string (optional) - What's blocking it

### update_status
Call to update the UI with your current activity (use sparingly).
- \`message\`: string - Status message to display

**Important:** These tools are intercepted by the harness. When you call them, they update the pipeline state and notify the UI. They don't execute any code - they're pure state signals.
`;

/**
 * Workflow tool names
 */
export const WORKFLOW_TOOL_NAMES = [
  "start_requirement",
  "complete_requirement",
  "fail_requirement",
  "update_status",
] as const;

export type WorkflowToolName = typeof WORKFLOW_TOOL_NAMES[number];

/**
 * Check if a tool name is a workflow tool
 */
export function isWorkflowTool(toolName: string): toolName is WorkflowToolName {
  return WORKFLOW_TOOL_NAMES.includes(toolName as WorkflowToolName);
}

/**
 * Input types for workflow tools
 */
export interface StartRequirementInput {
  requirementId: string;
  approach: string;
}

export interface CompleteRequirementInput {
  requirementId: string;
  summary: string;
  filesModified: string[];
}

export interface FailRequirementInput {
  requirementId: string;
  reason: string;
  blockedBy?: string;
}

export interface UpdateStatusInput {
  message: string;
}

export type WorkflowToolInput =
  | StartRequirementInput
  | CompleteRequirementInput
  | FailRequirementInput
  | UpdateStatusInput;

/**
 * Handle a workflow tool call
 * Returns the result string to pass back to the agent
 */
export function handleWorkflowTool(
  pipelineId: string,
  toolName: WorkflowToolName,
  input: unknown,
  eventBridge: EventBridge
): string {
  // Delegate to event bridge for event emission
  const result = eventBridge.onWorkflowTool(toolName, input);

  // Also update pipeline state directly for requirement status
  const args = input as Record<string, unknown>;

  switch (toolName) {
    case "start_requirement":
      updateRequirement(pipelineId, String(args.requirementId), "in_progress");
      break;
    case "complete_requirement":
      updateRequirement(pipelineId, String(args.requirementId), "completed");
      addCompletedRequirement(pipelineId, String(args.requirementId));
      break;
    case "fail_requirement":
      updateRequirement(pipelineId, String(args.requirementId), "failed");
      addFailedRequirement(pipelineId, String(args.requirementId));
      break;
  }

  return result;
}

/**
 * Check if all requirements are processed (completed or failed)
 */
export function areAllRequirementsProcessed(pipelineId: string): boolean {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return true;

  return pipeline.requirements.every(
    (r) => r.status === "completed" || r.status === "failed"
  );
}

/**
 * Get summary of requirement statuses
 */
export function getRequirementsSummary(pipelineId: string): {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  inProgress: number;
} {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) {
    return { total: 0, completed: 0, failed: 0, pending: 0, inProgress: 0 };
  }

  const requirements = pipeline.requirements;
  return {
    total: requirements.length,
    completed: requirements.filter((r) => r.status === "completed").length,
    failed: requirements.filter((r) => r.status === "failed").length,
    pending: requirements.filter((r) => r.status === "pending").length,
    inProgress: requirements.filter((r) => r.status === "in_progress").length,
  };
}
