/**
 * Harness Module
 *
 * Provides the autonomous agent harness that replaces the rigid pipeline.
 */

export { runHarness, type HarnessConfig, type HarnessResult } from "./harness";
export { EventBridge } from "./event-bridge";
export { areAllRequirementsProcessed, getRequirementsSummary } from "./requirements";
export { createWorkflowMcpServer } from "./workflow-mcp";
