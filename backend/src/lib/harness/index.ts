/**
 * Harness Module
 *
 * Provides the autonomous agent harness that replaces the rigid pipeline.
 */

export { runHarness, type HarnessConfig, type HarnessResult } from "./harness";
export { EventBridge } from "./event-bridge";
export {
  isWorkflowTool,
  handleWorkflowTool,
  areAllRequirementsProcessed,
  getRequirementsSummary,
  WORKFLOW_TOOL_DEFINITIONS,
  WORKFLOW_TOOL_NAMES,
  type WorkflowToolName,
} from "./workflow-tools";
