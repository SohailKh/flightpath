/**
 * Event Bridge
 *
 * Bridges tool calls from the agent to pipeline events for UI.
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

function normalizeWorkflowToolName(toolName: string): string {
  return toolName.startsWith("mcp__workflow__")
    ? toolName.replace("mcp__workflow__", "")
    : toolName;
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
  const normalizedToolName = normalizeWorkflowToolName(toolName);
  switch (normalizedToolName) {
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
    case "WebSearch":
      return `Searching web for "${truncateStr(String(args.query || ""), 40)}"`;
    case "Task": {
      const desc = args.description as string | undefined;
      if (desc) return desc;
      return `Running agent: ${args.subagent_type || "task"}`;
    }
    case "AskUserQuestion": {
      const questions = args.questions as Array<{ header?: string; question?: string }> | undefined;
      if (questions && questions.length > 0) {
        const header = questions[0].header;
        if (header) return `Asking: ${header}`;
      }
      return "Asking user...";
    }
    // Workflow tools
    case "start_requirement":
      return `Starting requirement: ${args.id}`;
    case "complete_requirement":
      return `Completed requirement: ${args.id}`;
    case "fail_requirement":
      return `Failed requirement: ${args.id}`;
    case "update_status":
      return `Status: ${args.id} -> ${args.status}`;
    case "log_progress":
      return String(args.message || "Progress update");
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
function isTestingCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized.includes("playwright:smoke") ||
    normalized.includes("playwright:screenshot") ||
    normalized.includes("playwright-smoke") ||
    normalized.includes("playwright-screenshot")
  );
}

function inferPhase(toolName: string, toolInput: unknown): InferredPhase {
  // Exploration tools
  if (["Glob", "Grep", "Read"].includes(toolName)) {
    return "exploring";
  }
  // Execution tools
  if (["Write", "Edit"].includes(toolName)) {
    return "executing";
  }
  if (toolName === "Bash") {
    const command = String((toolInput as { command?: unknown })?.command ?? "");
    if (command && isTestingCommand(command)) {
      return "testing";
    }
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
  "log_progress",
  "get_requirements",
];

/**
 * Event Bridge - bridges tool calls to pipeline events
 */
export class EventBridge {
  private pipelineId: string;
  private agentName: string;
  private currentPhase: InferredPhase = "unknown";
  private toolStartTimes = new Map<string, number>();
  private turnInputTokens = 0;
  private turnOutputTokens = 0;

  constructor(pipelineId: string, agentName: string = "harness") {
    this.pipelineId = pipelineId;
    this.agentName = agentName;
  }

  /**
   * Set token delta for the current turn (called from harness after each assistant message)
   */
  setTurnTokenDelta(inputTokens: number, outputTokens: number): void {
    this.turnInputTokens = inputTokens;
    this.turnOutputTokens = outputTokens;
  }

  /**
   * Get and clear the current turn's token usage
   */
  private consumeTurnTokens(): { inputTokens: number; outputTokens: number } | null {
    if (this.turnInputTokens === 0 && this.turnOutputTokens === 0) {
      return null;
    }
    const tokens = {
      inputTokens: this.turnInputTokens,
      outputTokens: this.turnOutputTokens,
    };
    this.turnInputTokens = 0;
    this.turnOutputTokens = 0;
    return tokens;
  }

  /**
   * Check if a tool is a workflow tool
   */
  isWorkflowTool(toolName: string): boolean {
    return WORKFLOW_TOOLS.includes(normalizeWorkflowToolName(toolName));
  }

  /**
   * Handle tool start - emit events and track phase
   */
  onToolStart(toolName: string, toolInput: unknown, toolUseId: string): void {
    this.toolStartTimes.set(toolUseId, Date.now());

    // Infer and emit phase transitions for UI backward compat
    const newPhase = inferPhase(toolName, toolInput);
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
      agentName: this.agentName,
    });

    // Emit human-readable status
    appendEvent(this.pipelineId, "status_update", {
      action: formatStatusAction(toolName, toolInput),
      inferredPhase: newPhase,
      agentName: this.agentName,
      statusSource: "tool",
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

    // Get token usage for this step
    const tokenUsage = this.consumeTurnTokens();

    appendEvent(this.pipelineId, "tool_completed", {
      toolName,
      toolUseId,
      durationMs: duration,
      result: passResult(result),
      outcome,
      inferredPhase: this.currentPhase,
      agentName: this.agentName,
      ...(tokenUsage && {
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
      }),
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
      agentName: this.agentName,
    });
  }

  /**
   * Handle TodoWrite tool calls - emit todo_update events
   */
  onTodoWrite(todos: unknown[]): void {
    appendEvent(this.pipelineId, "todo_update", {
      todos,
      phase: this.currentPhase,
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
          requirementId: input.id,
          note: input.note,
        });
        return `Started working on requirement ${input.id}`;

      case "complete_requirement":
        appendEvent(this.pipelineId, "requirement_completed", {
          requirementId: input.id,
          note: input.note,
        });
        return `Marked requirement ${input.id} as completed`;

      case "fail_requirement":
        appendEvent(this.pipelineId, "requirement_failed", {
          requirementId: input.id,
          reason: input.reason,
        });
        return `Marked requirement ${input.id} as failed: ${input.reason}`;

      case "update_status":
        appendEvent(this.pipelineId, "status_update", {
          action: String(input.note || "Working..."),
          requirementId: input.id,
          requirementStatus: input.status,
          inferredPhase: this.currentPhase,
          agentName: this.agentName,
          statusSource: "workflow",
        });
        return "Status updated";
      case "log_progress":
        appendEvent(this.pipelineId, "status_update", {
          action: String(input.message || "Progress update"),
          requirementId: input.requirementId,
          level: input.level,
          inferredPhase: this.currentPhase,
          agentName: this.agentName,
          statusSource: "workflow",
        });
        return "Progress logged";

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
          agentName: this.agentName,
          statusSource: "agent",
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
