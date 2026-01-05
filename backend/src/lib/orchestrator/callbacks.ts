/**
 * Orchestrator Callbacks
 *
 * Creates callback handlers for tool events and server logging.
 */

import { appendEvent } from "../pipeline";
import { type ToolEventCallbacks } from "../agent";
import { LOG, logTool, truncateResult, VERBOSE, logVerbose } from "./utils";

/**
 * Create tool callbacks for a specific phase
 */
export function createToolCallbacks(
  pipelineId: string,
  phase: "qa" | "exploring" | "planning" | "executing" | "testing"
): ToolEventCallbacks {
  const phaseLabel = phase === "qa" ? "QA" : phase.charAt(0).toUpperCase() + phase.slice(1);

  return {
    onToolStart: (toolName, toolInput, toolUseId) => {
      logTool(phaseLabel, toolName, toolInput);
      appendEvent(pipelineId, "tool_started", {
        toolName,
        toolUseId,
        args: toolInput,
        phase,
      });
    },
    onToolComplete: (toolName, toolInput, toolUseId, result, durationMs) => {
      logTool(phaseLabel, toolName, toolInput, `complete (${durationMs}ms)`);
      // Detect outcome based on result content
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      const hasError = /error|failed|exception|denied|not found/i.test(resultStr);
      const outcome = hasError ? "warning" : "success";

      // Verbose: log tool result details
      if (VERBOSE) {
        logVerbose(phaseLabel, `Tool ${toolName} completed`, {
          outcome,
          duration: `${durationMs}ms`,
          result: resultStr.slice(0, 500),
        });
      }

      appendEvent(pipelineId, "tool_completed", {
        toolName,
        toolUseId,
        durationMs,
        result: truncateResult(result),
        outcome,
        phase,
      });
    },
    onToolError: (toolName, toolInput, toolUseId, error) => {
      console.log(`${LOG.error} ${phaseLabel} | ${toolName} failed: ${error}`);
      appendEvent(pipelineId, "tool_error", {
        toolName,
        toolUseId,
        error,
        phase,
      });
    },
    onStatusUpdate: (action) => {
      appendEvent(pipelineId, "status_update", { action, phase });
    },
  };
}

/**
 * Create logging callbacks for dev server management
 */
export function createServerLogCallbacks(pipelineId: string) {
  return {
    onLog: (platform: string, message: string) => {
      console.log(`${LOG.test} [${platform}] ${message}`);
      appendEvent(pipelineId, "status_update", {
        action: `[${platform}] ${message}`,
        phase: "testing",
      });
    },
    onHealthy: (platform: string) => {
      appendEvent(pipelineId, "server_healthy", { platform });
    },
    onError: (platform: string, error: string) => {
      appendEvent(pipelineId, "server_error", { platform, error });
    },
  };
}

/**
 * Emit todo events from agent structured output
 */
export function emitTodoEvents(
  pipelineId: string,
  phase: "qa" | "exploring" | "planning" | "executing" | "testing",
  structuredOutput: unknown
): void {
  // Verbose: log structured output details
  if (VERBOSE && structuredOutput && typeof structuredOutput === "object") {
    logVerbose(phase.toUpperCase(), "Structured output", {
      keys: Object.keys(structuredOutput as object).join(", "),
      preview: JSON.stringify(structuredOutput).slice(0, 200),
    });
  }

  if (!structuredOutput || typeof structuredOutput !== "object") return;

  const output = structuredOutput as { todos?: unknown[] };
  if (!Array.isArray(output.todos) || output.todos.length === 0) return;

  appendEvent(pipelineId, "todo_update", {
    todos: output.todos,
    phase,
  });
}
