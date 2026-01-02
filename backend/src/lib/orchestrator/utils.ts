/**
 * Orchestrator Utilities
 *
 * Logging helpers and formatting utilities used across orchestrator phases.
 */

// Colored log prefixes for terminal output
export const LOG = {
  pipeline: "\x1b[36m[Pipeline]\x1b[0m",  // Cyan
  qa: "\x1b[33m[QA]\x1b[0m",               // Yellow
  explore: "\x1b[96m[Explore]\x1b[0m",    // Bright Cyan
  plan: "\x1b[35m[Plan]\x1b[0m",           // Magenta
  execute: "\x1b[32m[Execute]\x1b[0m",     // Green
  test: "\x1b[34m[Test]\x1b[0m",           // Blue
  tool: "\x1b[90m[Tool]\x1b[0m",           // Gray
  error: "\x1b[31m[Error]\x1b[0m",         // Red
};

/**
 * Log a tool event with phase context
 */
export function logTool(phase: string, toolName: string, args: unknown, suffix?: string) {
  const argsPreview = formatArgsPreview(args);
  const suffixStr = suffix ? ` ${suffix}` : "";
  console.log(`${LOG.tool} ${phase} | ${toolName}${suffixStr}: ${argsPreview}`);
}

/**
 * Log a phase event
 */
export function logPhase(phase: keyof typeof LOG, message: string, detail?: string) {
  const prefix = LOG[phase] || LOG.pipeline;
  console.log(`${prefix} ${message}${detail ? ": " + detail : ""}`);
}

/**
 * Format tool arguments for logging preview
 */
export function formatArgsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;

  if ("file_path" in obj) return String(obj.file_path);
  if ("command" in obj) {
    const cmd = String(obj.command);
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  if ("pattern" in obj) return `pattern="${obj.pattern}"`;
  if ("content" in obj) return `[content: ${String(obj.content).length} chars]`;

  const json = JSON.stringify(args);
  return json.length > 80 ? json.slice(0, 77) + "..." : json;
}

/**
 * Truncate a result for logging
 */
export function truncateResult(result: unknown): string {
  const str = typeof result === "string" ? result : JSON.stringify(result);
  return str.length > 200 ? str.slice(0, 197) + "..." : str;
}
