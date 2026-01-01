import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadProjectConfig, generateProjectContext } from "./project-config";
import {
  initBrowser,
  closeBrowser,
  executePlaywrightTool,
  formatPlaywrightToolsForPrompt,
} from "./playwright-tools";
import type { BrowserOptions } from "./playwright-types";

export interface AgentResult {
  reply: string;
  requestId: string;
}

export interface AgentRunner {
  run(message: string): Promise<AgentResult>;
}

/**
 * Available agent types for the pipeline
 */
export type AgentName =
  | "feature-qa"
  | "feature-planner"
  | "feature-executor"
  | "feature-tester"
  | "feature-init"
  | "feature-doctor"
  | "feature-explorer"
  | "explorer-pattern"
  | "explorer-api"
  | "explorer-test";

/**
 * Message format for conversation history
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Callback for tool events
 */
export interface ToolEventCallbacks {
  onToolStart?: (toolName: string, toolInput: unknown, toolUseId: string) => void;
  onToolComplete?: (toolName: string, toolInput: unknown, toolUseId: string, result: unknown, durationMs: number) => void;
  onToolError?: (toolName: string, toolInput: unknown, toolUseId: string, error: string) => void;
  onStatusUpdate?: (action: string) => void;
}

/**
 * Options for creating an agent with a specific prompt
 */
export interface AgentWithPromptOptions {
  agentName: AgentName;
  conversationHistory?: ConversationMessage[];
  maxTurns?: number;
  onStreamChunk?: (chunk: string) => void;
  onToolCall?: (toolName: string, args: unknown) => Promise<unknown>;
  /** Path to target project for context injection */
  targetProjectPath?: string;
  /** Callbacks for tool activity events */
  toolCallbacks?: ToolEventCallbacks;
  /** Override the model specified in agent frontmatter */
  modelOverride?: string;
  /** Enable Playwright web testing tools */
  enablePlaywrightTools?: boolean;
  /** Playwright browser options */
  playwrightOptions?: BrowserOptions;
}

/**
 * Option for AskUserQuestion tool
 */
export interface QuestionOption {
  label: string;
  description: string;
}

/**
 * Question structure from AskUserQuestion tool
 */
export interface AskUserQuestion {
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * Extended result for pipeline agents
 */
export interface PipelineAgentResult extends AgentResult {
  conversationHistory: ConversationMessage[];
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  requiresUserInput: boolean;
  userQuestion?: string;
  userQuestions?: AskUserQuestion[];
}

/**
 * Load an agent prompt from the agents directory
 * Optionally injects project context from target project's .claude/project-config.json
 */
async function loadAgentPrompt(
  agentName: AgentName,
  targetProjectPath?: string
): Promise<string> {
  // When running from backend/, use src/agents directly
  // When running from root, use backend/src/agents
  let agentsDir = join(process.cwd(), "src", "agents");
  if (!existsSync(agentsDir)) {
    agentsDir = join(process.cwd(), "backend", "src", "agents");
  }
  const promptPath = join(agentsDir, `${agentName}.md`);

  if (!existsSync(promptPath)) {
    throw new Error(`Agent prompt not found: ${promptPath}`);
  }

  const rawContent = await readFile(promptPath, "utf-8");

  // Extract just the content after the frontmatter
  const frontmatterEnd = rawContent.indexOf("---", 4);
  let content =
    frontmatterEnd === -1
      ? rawContent
      : rawContent.substring(frontmatterEnd + 3).trim();

  // Inject project context if target path provided
  if (targetProjectPath) {
    const config = await loadProjectConfig(targetProjectPath);
    const contextSection = generateProjectContext(config);
    content = contextSection + "\n\n" + content;
  }

  return content;
}

/**
 * Parse frontmatter from agent markdown file
 */
async function parseAgentFrontmatter(
  agentName: AgentName
): Promise<Record<string, unknown>> {
  let agentsDir = join(process.cwd(), "src", "agents");
  if (!existsSync(agentsDir)) {
    agentsDir = join(process.cwd(), "backend", "src", "agents");
  }
  const promptPath = join(agentsDir, `${agentName}.md`);

  if (!existsSync(promptPath)) {
    return {};
  }

  const content = await readFile(promptPath, "utf-8");

  // Extract frontmatter
  if (!content.startsWith("---")) {
    return {};
  }

  const frontmatterEnd = content.indexOf("---", 4);
  if (frontmatterEnd === -1) {
    return {};
  }

  const frontmatter = content.substring(4, frontmatterEnd).trim();
  const result: Record<string, unknown> = {};

  for (const line of frontmatter.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex !== -1) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      result[key] = value;
    }
  }

  return result;
}

/**
 * Creates an agent runner with the Claude Agent SDK.
 * Uses Claude Code's authentication (must be logged in via `claude login`).
 */
export function createAgentRunner(): AgentRunner {
  return {
    async run(message: string): Promise<AgentResult> {
      const requestId = crypto.randomUUID();
      let resultText = "";

      const q = query({
        prompt: message,
        options: {
          maxTurns: 1,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          tools: [], // No tools for this simple demo
        },
      });

      for await (const msg of q) {
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success") {
            resultText = result.result;
          } else {
            throw new Error(
              `Agent error: ${result.subtype}${
                "errors" in result ? ` - ${result.errors.join(", ")}` : ""
              }`
            );
          }
        }
      }

      return {
        reply: resultText || "No response from agent",
        requestId,
      };
    },
  };
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
    case "Bash":
      return `Running: ${truncateStr(String(args.command || ""), 40)}`;
    case "Glob":
      return `Searching for ${args.pattern}`;
    case "Grep":
      return `Searching for "${truncateStr(String(args.pattern || ""), 30)}"`;
    case "WebFetch":
      return `Fetching ${truncateStr(String(args.url || ""), 40)}`;
    case "Task":
      return `Running agent: ${args.subagent_type || "task"}`;
    default:
      return `${toolName}...`;
  }
}

function truncatePath(path: string): string {
  if (!path) return "";
  const parts = path.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : path;
}

function truncateStr(str: string, len: number): string {
  if (!str) return "";
  return str.length > len ? str.slice(0, len - 3) + "..." : str;
}

/**
 * Map short model names to full SDK model identifiers
 */
function mapModelName(shortName?: string): string | undefined {
  if (!shortName) return undefined;
  const modelMap: Record<string, string> = {
    haiku: "claude-haiku-3-5-20241022",
    sonnet: "claude-sonnet-4-5-20250929",
    opus: "claude-opus-4-20250514",
  };
  return modelMap[shortName.toLowerCase()] || shortName;
}

/**
 * Creates an agent runner for a specific pipeline agent with full configuration.
 * Supports multi-turn conversations and streaming.
 */
export async function createPipelineAgent(
  options: AgentWithPromptOptions
): Promise<PipelineAgentResult> {
  const {
    agentName,
    conversationHistory = [],
    maxTurns = 10,
    onStreamChunk,
    targetProjectPath,
    toolCallbacks,
    modelOverride,
    enablePlaywrightTools = false,
    playwrightOptions,
  } = options;

  // Initialize Playwright browser if enabled
  if (enablePlaywrightTools) {
    await initBrowser(playwrightOptions);
  }

  // Determine effective model: override > frontmatter > default
  const frontmatter = await parseAgentFrontmatter(agentName);
  const declaredModel = frontmatter.model as string | undefined;
  const effectiveModel = modelOverride || mapModelName(declaredModel);

  const requestId = crypto.randomUUID();
  let systemPrompt = await loadAgentPrompt(agentName, targetProjectPath);

  // Inject context for new projects (no target path = building from scratch)
  if (!targetProjectPath) {
    systemPrompt = `## Context
This is a NEW PROJECT - there is no existing codebase to analyze.
Skip all file operations (git, Read, Glob, Grep, Bash) and proceed directly to interviewing the user about what they want to build.

` + systemPrompt;
  }

  const toolCalls: PipelineAgentResult["toolCalls"] = [];
  let resultText = "";
  let requiresUserInput = false;
  let userQuestion: string | undefined;
  let userQuestions: AskUserQuestion[] | undefined;

  // Track tool start times for duration calculation
  const toolStartTimes = new Map<string, number>();

  // Build the full prompt with conversation history
  let fullPrompt = systemPrompt + "\n\n";

  // Inject Playwright tool definitions if enabled
  if (enablePlaywrightTools) {
    fullPrompt += "## Web Testing Tools (Playwright)\n\n";
    fullPrompt += "You have access to Playwright web testing tools for browser automation:\n\n";
    fullPrompt += formatPlaywrightToolsForPrompt();
    fullPrompt += "\n\n";
  }

  if (conversationHistory.length > 0) {
    fullPrompt += "## Conversation History\n\n";
    for (const msg of conversationHistory) {
      fullPrompt += `**${msg.role === "user" ? "User" : "Assistant"}:** ${msg.content}\n\n`;
    }
  }

  // Wrap execution in try/finally to ensure browser cleanup
  try {
  const q = query({
    prompt: fullPrompt,
    options: {
      maxTurns,
      // Pass model to SDK if specified (override or from frontmatter)
      ...(effectiveModel && { model: effectiveModel }),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Set working directory for agent if target project path is provided
      ...(targetProjectPath && { cwd: targetProjectPath }),
      // Hook callbacks for tool events
      hooks: (toolCallbacks || enablePlaywrightTools) ? {
        PreToolUse: [{
          hooks: [async (input) => {
            if (input.hook_event_name === "PreToolUse") {
              toolStartTimes.set(input.tool_use_id, Date.now());
              toolCallbacks?.onToolStart?.(input.tool_name, input.tool_input, input.tool_use_id);
              toolCallbacks?.onStatusUpdate?.(formatStatusAction(input.tool_name, input.tool_input));

              // Intercept Playwright web_* tools
              if (enablePlaywrightTools && input.tool_name.startsWith("web_")) {
                try {
                  const result = await executePlaywrightTool(
                    input.tool_name,
                    input.tool_input as Record<string, unknown>
                  );

                  // Record the tool call
                  toolCalls.push({
                    name: input.tool_name,
                    args: input.tool_input,
                    result,
                  });

                  // Return the result to the agent
                  // Note: We serialize without the screenshot buffer for the response
                  const serializedResult = {
                    ...result,
                    screenshot: result.screenshot ? "(screenshot captured)" : undefined,
                  };

                  return {
                    continue: true,
                    tool_result: JSON.stringify(serializedResult),
                  };
                } catch (error) {
                  return {
                    continue: true,
                    tool_result: JSON.stringify({
                      success: false,
                      action: input.tool_name,
                      error: error instanceof Error ? error.message : String(error),
                    }),
                  };
                }
              }

              // Detect AskUserQuestion tool to capture questions for the frontend
              if (input.tool_name === "AskUserQuestion") {
                requiresUserInput = true;
                const toolInput = input.tool_input as { questions?: AskUserQuestion[] };
                userQuestions = toolInput?.questions;
                toolCalls.push({
                  name: input.tool_name,
                  args: input.tool_input,
                  result: null,
                });
              }
            }
            return { continue: true };
          }],
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            if (input.hook_event_name === "PostToolUse") {
              const startTime = toolStartTimes.get(input.tool_use_id) || Date.now();
              const durationMs = Date.now() - startTime;
              toolStartTimes.delete(input.tool_use_id);
              toolCallbacks?.onToolComplete?.(input.tool_name, input.tool_input, input.tool_use_id, input.tool_response, durationMs);
            }
            return { continue: true };
          }],
        }],
        PostToolUseFailure: [{
          hooks: [async (input) => {
            if (input.hook_event_name === "PostToolUseFailure") {
              toolStartTimes.delete(input.tool_use_id);
              toolCallbacks?.onToolError?.(input.tool_name, input.tool_input, input.tool_use_id, input.error);
            }
            return { continue: true };
          }],
        }],
      } : undefined,
    },
  });

  for await (const msg of q) {
    // Handle streaming chunks if callback provided
    if (msg.type === "assistant" && onStreamChunk) {
      // The SDK might provide partial content
      if ("content" in msg && typeof msg.content === "string") {
        onStreamChunk(msg.content);
      }
    }

    if (msg.type === "result") {
      const result = msg as SDKResultMessage;
      if (result.subtype === "success") {
        resultText = result.result;
      } else {
        throw new Error(
          `Agent error: ${result.subtype}${
            "errors" in result ? ` - ${result.errors.join(", ")}` : ""
          }`
        );
      }
    }
  }

  // Update conversation history with new messages
  const updatedHistory: ConversationMessage[] = [
    ...conversationHistory,
    { role: "assistant", content: resultText },
  ];

  return {
    reply: resultText || "No response from agent",
    requestId,
    conversationHistory: updatedHistory,
    toolCalls,
    requiresUserInput,
    userQuestion,
    userQuestions,
  };
  } finally {
    // Cleanup Playwright browser if it was initialized
    if (enablePlaywrightTools) {
      await closeBrowser();
    }
  }
}

/**
 * Run a pipeline agent with a user message (for multi-turn QA)
 */
export async function runPipelineAgentWithMessage(
  agentName: AgentName,
  userMessage: string,
  previousHistory: ConversationMessage[] = [],
  onStreamChunk?: (chunk: string) => void,
  targetProjectPath?: string,
  maxTurns?: number,
  toolCallbacks?: ToolEventCallbacks
): Promise<PipelineAgentResult> {
  // Add the user message to history
  const historyWithUserMessage: ConversationMessage[] = [
    ...previousHistory,
    { role: "user", content: userMessage },
  ];

  return createPipelineAgent({
    agentName,
    conversationHistory: historyWithUserMessage,
    onStreamChunk,
    targetProjectPath,
    maxTurns,
    toolCallbacks,
  });
}

/**
 * Playwright options for agent execution
 */
export interface PlaywrightAgentOptions {
  /** Enable Playwright web testing tools */
  enablePlaywrightTools?: boolean;
  /** Playwright browser options */
  playwrightOptions?: BrowserOptions;
}

/**
 * Run a pipeline agent with just a prompt (for starting a phase)
 */
export async function runPipelineAgent(
  agentName: AgentName,
  initialPrompt: string,
  onStreamChunk?: (chunk: string) => void,
  targetProjectPath?: string,
  maxTurns?: number,
  toolCallbacks?: ToolEventCallbacks,
  playwrightAgentOptions?: PlaywrightAgentOptions
): Promise<PipelineAgentResult> {
  return createPipelineAgent({
    agentName,
    conversationHistory: [{ role: "user", content: initialPrompt }],
    onStreamChunk,
    targetProjectPath,
    maxTurns,
    toolCallbacks,
    ...playwrightAgentOptions,
  });
}
