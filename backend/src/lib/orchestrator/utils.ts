/**
 * Orchestrator Utilities
 *
 * Logging helpers and formatting utilities used across orchestrator phases.
 */

// Verbose logging - enabled by default, disable with VERBOSE=false
export const VERBOSE = process.env.VERBOSE !== "false";

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
  verbose: "\x1b[90m[Verbose]\x1b[0m",    // Gray
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
 * Log a phase event with optional pipeline ID correlation
 */
export function logPhase(phase: keyof typeof LOG, message: string, detail?: string, pipelineId?: string) {
  const prefix = LOG[phase] || LOG.pipeline;
  const id = pipelineId ? `${pipelineId.slice(0, 8)} ` : "";
  console.log(`${prefix} ${id}${message}${detail ? ": " + detail : ""}`);
}

/**
 * Format tool arguments for logging preview
 */
export function formatArgsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;

  if ("file_path" in obj) return String(obj.file_path);
  if ("command" in obj) {
    const cmd = String(obj.command).replace(/\n/g, "\\n");
    return cmd.length > 120 ? cmd.slice(0, 117) + "..." : cmd;
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

/**
 * Log verbose details when VERBOSE mode is enabled
 */
export function logVerbose(phase: string, message: string, details?: Record<string, unknown>): void {
  if (!VERBOSE) return;
  console.log(`${LOG.verbose} ${phase} | ${message}`);
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      console.log(`${LOG.verbose} ${phase} |   ${key}: ${str.slice(0, 300)}`);
    }
  }
}
