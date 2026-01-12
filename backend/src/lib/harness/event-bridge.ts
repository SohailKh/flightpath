/**
 * Event Bridge
 *
 * Bridges tool calls from the unified agent to pipeline events for UI.
 * Infers "phase" from tool type for backward compatibility with UI.
 */

import { appendEvent } from "../pipeline";
import type { ToolEventCallbacks } from "../agent";

type InferredPhase = "exploring" | "executing" | "testing" | "unknown";

/**
 * Truncate a file path for display
 */
function truncatePath(path: string): string {
  if (!path) return "";
  const parts = path.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
}

/**
 * Truncate a string for display
 */
function truncateStr(str: string, len: number): string {
  if (!str) return "";
  return str.length > len ? str.slice(0, len - 3) + "..." : str;
}

/**
 * Pass through tool result without truncation for full visibility
 */
function passResult(result: unknown): unknown {
  return result;
}

/**
 * Format a human-readable status action from tool info
 */
function formatStatusAction(toolName: string, input: unknown): string {
  const args = input as Record<string, unknown>;
  switch (toolName) {
    case "Read":
      return `Reading ${truncatePath(String(args.file_path || ""))}`;
    case "Edit":
      return `Editing ${truncatePath(String(args.file_path || ""))}`;
    case "Write":
      return `Writing ${truncatePath(String(args.file_path || ""))}`;
    case "Bash": {
      const desc = args.description as string | undefined;
      if (desc) return desc;
      return `Running: ${truncateStr(String(args.command || ""), 60)}`;
    }
    case "Glob":
      return `Searching for ${args.pattern}`;
    case "Grep":
      return `Searching for "${truncateStr(String(args.pattern || ""), 30)}"`;
    case "WebFetch":
      return `Fetching ${truncateStr(String(args.url || ""), 40)}`;
    case "Task": {
      const desc = args.description as string | undefined;
      if (desc) return desc;
      return `Running agent: ${args.subagent_type || "task"}`;
    }
    // Workflow tools
    case "start_requirement":
      return `Starting requirement: ${args.requirementId}`;
    case "complete_requirement":
      return `Completed requirement: ${args.requirementId}`;
    case "fail_requirement":
      return `Failed requirement: ${args.requirementId}`;
    case "update_status":
      return String(args.message || "Working...");
    // Playwright tools
    case "web_navigate":
      return `Navigating to ${truncateStr(String(args.url || ""), 40)}`;
    case "web_click":
      return `Clicking ${truncateStr(String(args.selector || ""), 30)}`;
    case "web_type":
      return `Typing in ${truncateStr(String(args.selector || ""), 30)}`;
    case "web_screenshot":
      return "Taking screenshot";
    default:
      return `${toolName}...`;
  }
}

/**
 * Infer phase from tool name for UI backward compatibility
 */
function inferPhase(toolName: string): InferredPhase {
  // Exploration tools
  if (["Glob", "Grep", "Read"].includes(toolName)) {
    return "exploring";
  }
  // Execution tools
  if (["Write", "Edit", "Bash"].includes(toolName)) {
    return "executing";
  }
  // Testing tools
  if (toolName.startsWith("web_") || toolName === "start_dev_server" || toolName === "stop_dev_server") {
    return "testing";
  }
  return "unknown";
}

/**
 * Workflow tool names that signal state changes
 */
const WORKFLOW_TOOLS = [
  "start_requirement",
  "complete_requirement",
  "fail_requirement",
  "update_status",
];

/**
 * Event Bridge - bridges tool calls to pipeline events
 */
export class EventBridge {
  private pipelineId: string;
  private currentPhase: InferredPhase = "unknown";
  private toolStartTimes = new Map<string, number>();

  constructor(pipelineId: string) {
    this.pipelineId = pipelineId;
  }

  /**
   * Check if a tool is a workflow tool
   */
  isWorkflowTool(toolName: string): boolean {
    return WORKFLOW_TOOLS.includes(toolName);
  }

  /**
   * Handle tool start - emit events and track phase
   */
  onToolStart(toolName: string, toolInput: unknown, toolUseId: string): void {
    this.toolStartTimes.set(toolUseId, Date.now());

    // Infer and emit phase transitions for UI backward compat
    const newPhase = inferPhase(toolName);
    if (newPhase !== "unknown" && newPhase !== this.currentPhase) {
      // Emit phase completed for previous phase
      if (this.currentPhase !== "unknown") {
        appendEvent(this.pipelineId, `${this.currentPhase}_completed`, {});
      }
      // Emit phase started for new phase
      appendEvent(this.pipelineId, `${newPhase}_started`, {});
      this.currentPhase = newPhase;
    }

    // Emit tool started event
    appendEvent(this.pipelineId, "tool_started", {
      toolName,
      toolUseId,
      args: toolInput,
      inferredPhase: newPhase,
    });

    // Emit human-readable status
    appendEvent(this.pipelineId, "status_update", {
      action: formatStatusAction(toolName, toolInput),
      inferredPhase: newPhase,
    });
  }

  /**
   * Handle tool completion
   */
  onToolComplete(
    toolName: string,
    toolInput: unknown,
    toolUseId: string,
    result: unknown,
    durationMs?: number
  ): void {
    const startTime = this.toolStartTimes.get(toolUseId);
    const duration = durationMs ?? (startTime ? Date.now() - startTime : 0);
    this.toolStartTimes.delete(toolUseId);

    // Detect outcome based on result content
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    const hasError = /error|failed|exception|denied|not found/i.test(resultStr);
    const outcome = hasError ? "warning" : "success";

    appendEvent(this.pipelineId, "tool_completed", {
      toolName,
      toolUseId,
      durationMs: duration,
      result: passResult(result),
      outcome,
      inferredPhase: this.currentPhase,
    });
  }

  /**
   * Handle tool error
   */
  onToolError(toolName: string, toolInput: unknown, toolUseId: string, error: string): void {
    this.toolStartTimes.delete(toolUseId);
    console.error(`[Harness] Tool ${toolName} failed: ${error}`);

    appendEvent(this.pipelineId, "tool_error", {
      toolName,
      toolUseId,
      error,
      inferredPhase: this.currentPhase,
    });
  }

  /**
   * Handle workflow tool calls - emit special events for requirements
   */
  onWorkflowTool(toolName: string, args: unknown): string {
    const input = args as Record<string, unknown>;

    switch (toolName) {
      case "start_requirement":
        appendEvent(this.pipelineId, "requirement_started", {
          requirementId: input.requirementId,
          approach: input.approach,
        });
        return `Started working on requirement ${input.requirementId}`;

      case "complete_requirement":
        appendEvent(this.pipelineId, "requirement_completed", {
          requirementId: input.requirementId,
          summary: input.summary,
          filesModified: input.filesModified,
        });
        return `Marked requirement ${input.requirementId} as completed`;

      case "fail_requirement":
        appendEvent(this.pipelineId, "requirement_failed", {
          requirementId: input.requirementId,
          reason: input.reason,
          blockedBy: input.blockedBy,
        });
        return `Marked requirement ${input.requirementId} as failed: ${input.reason}`;

      case "update_status":
        appendEvent(this.pipelineId, "status_update", {
          action: String(input.message),
          inferredPhase: this.currentPhase,
        });
        return "Status updated";

      default:
        return `Unknown workflow tool: ${toolName}`;
    }
  }

  /**
   * Create ToolEventCallbacks for use with agent.ts
   */
  createCallbacks(): ToolEventCallbacks {
    return {
      onToolStart: (toolName, toolInput, toolUseId) => {
        this.onToolStart(toolName, toolInput, toolUseId);
      },
      onToolComplete: (toolName, toolInput, toolUseId, result, durationMs) => {
        this.onToolComplete(toolName, toolInput, toolUseId, result, durationMs);
      },
      onToolError: (toolName, toolInput, toolUseId, error) => {
        this.onToolError(toolName, toolInput, toolUseId, error);
      },
      onStatusUpdate: (action) => {
        appendEvent(this.pipelineId, "status_update", {
          action,
          inferredPhase: this.currentPhase,
        });
      },
    };
  }

  /**
   * Emit final phase completion when harness finishes
   */
  finalize(): void {
    if (this.currentPhase !== "unknown") {
      appendEvent(this.pipelineId, `${this.currentPhase}_completed`, {});
    }
  }
}
