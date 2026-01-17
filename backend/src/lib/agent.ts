import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadProjectConfig, generateProjectContext } from "./project-config";
import { VERBOSE, logVerbose } from "./orchestrator/utils";
import { buildClaudeCodeOptions, createPromptStream } from "./claude-query";
import { ensureLocalClaudeForToolInput, ensureProjectClaudeLayout } from "./claude-scaffold";

// Flightpath root directory - resolved at module load time so it doesn't change
// when agents run with a different cwd (targetProjectPath)
const FLIGHTPATH_ROOT = resolve(import.meta.dirname, "..", "..");
import {
  initBrowser,
  closeBrowser,
  executePlaywrightTool,
} from "./playwright-tools";
import type { BrowserOptions } from "./playwright-types";

/**
 * Available agent types for the pipeline
 */
export type AgentName =
  | "feature-qa"
  | "feature-spec"
  | "feature-planner"
  | "feature-executor"
  | "feature-tester"
  | "feature-init"
  | "feature-doctor"
  | "feature-explorer"
  | "explorer-pattern"
  | "explorer-api"
  | "explorer-test"
  | "research-web"
  | "design-system";

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
  onTodoUpdate?: (todos: unknown[]) => void;
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
  /** Treat target as a new project (skip file ops, no codebase analysis) */
  isNewProject?: boolean;
  /** Callbacks for tool activity events */
  toolCallbacks?: ToolEventCallbacks;
  /** Callback with the full prompt before the agent runs */
  onPrompt?: (prompt: string) => void;
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

// ============================================
// AskUserInput Types (for collecting secrets, files, and configuration)
// ============================================

export type UserInputFieldType = "text" | "secret" | "file" | "boolean";

export interface UserInputFieldBase {
  id: string;
  label: string;
  description?: string;
  required: boolean;
}

export interface SecretInputField extends UserInputFieldBase {
  type: "secret";
  envVarName: string;   // Maps to env var (e.g., "FAL_KEY")
  formatHint?: string;  // Pattern hint (e.g., "sk_...")
}

export interface FileInputField extends UserInputFieldBase {
  type: "file";
  accept?: string[];      // MIME types (e.g., ["audio/*"])
  maxSizeBytes?: number;
}

export interface TextInputField extends UserInputFieldBase {
  type: "text";
  placeholder?: string;
}

export interface BooleanInputField extends UserInputFieldBase {
  type: "boolean";
  trueLabel?: string;
  falseLabel?: string;
}

export type UserInputField = SecretInputField | FileInputField | TextInputField | BooleanInputField;

export interface AskUserInputRequest {
  id: string;
  header: string;
  description: string;
  fields: UserInputField[];
}

export interface UserInputFileRef {
  artifactId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
}

export interface UserInputFieldResponse {
  fieldId: string;
  value?: string;              // For text/secret
  fileRef?: UserInputFileRef;  // For file
  booleanValue?: boolean;      // For boolean
  skipped?: boolean;
}

export interface AskUserInputResponse {
  requestId: string;
  fields: UserInputFieldResponse[];
  respondedAt: string;
}

/**
 * Result for pipeline agents
 */
export interface PipelineAgentResult {
  reply: string;
  requestId: string;
  conversationHistory: ConversationMessage[];
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  requiresUserInput: boolean;
  userQuestion?: string;
  userQuestions?: AskUserQuestion[];
  structuredOutput?: unknown;
}

const PLAYWRIGHT_TOOL_SUMMARY =
  "Playwright tools available: web_navigate, web_click, web_type, web_fill, web_assert_visible, web_assert_text, web_wait, web_screenshot, web_http_request. See /testing for details.";

/**
 * Load an agent prompt from the agents directory
 * Optionally injects project context from target project's .claude/project-config.json
 */
async function loadAgentPrompt(
  agentName: AgentName,
  targetProjectPath?: string
): Promise<string> {
  // Use the resolved flightpath root to find agent prompts
  // This works regardless of the current working directory
  const agentsDir = join(FLIGHTPATH_ROOT, "src", "agents");
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
  // Use the resolved flightpath root to find agent prompts
  const agentsDir = join(FLIGHTPATH_ROOT, "src", "agents");
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
      // Use Claude's description if provided, otherwise show the command
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
    default:
      return `${normalizedToolName}...`;
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

function normalizeWorkflowToolName(toolName: string): string {
  return toolName.startsWith("mcp__workflow__")
    ? toolName.replace("mcp__workflow__", "")
    : toolName;
}

/**
 * Map short model names to full SDK model identifiers
 */
function mapModelName(shortName?: string): string | undefined {
  if (!shortName) return undefined;
  const modelMap: Record<string, string> = {
    haiku: "haiku",
    sonnet: "sonnet",
    opus: "opus",
  };
  return modelMap[shortName.toLowerCase()] || shortName;
}

/**
 * Creates an agent runner for a specific pipeline agent with full configuration.
 * Supports multi-turn conversations and streaming.
 *
 * @deprecated Use createV2Session from session.ts instead for new code.
 * This V1 implementation is kept for backwards compatibility with harness.ts
 * and parallel-explorer.ts which may still use it.
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
    isNewProject,
    toolCallbacks,
    onPrompt,
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

  if (targetProjectPath) {
    await ensureProjectClaudeLayout(targetProjectPath);
  }

  const requestId = crypto.randomUUID();
  console.log(`[Agent] Creating ${agentName} agent (model: ${effectiveModel || "default"})`);

  let agentPrompt = await loadAgentPrompt(agentName, targetProjectPath);

  // Inject context for new projects (no target path = building from scratch)
  const treatAsNewProject = isNewProject ?? !targetProjectPath;
  if (treatAsNewProject) {
    // Use targetProjectPath if provided so writes land in the new project folder
    const cwd = targetProjectPath || process.cwd();
    agentPrompt = `## Context
This is a NEW PROJECT - there is no existing codebase to analyze.
Skip all file operations (git, Read, Glob, Grep, Bash) and proceed directly to interviewing the user about what they want to build.

**Working Directory:** \`${cwd}\`
For pipeline artifacts (feature-spec.v3.json, smoke-tests.json, feature-map.json), always write under \`.claude/{featurePrefix}\` (the \`.claude\` path is remapped to backend storage). Do not write those files into the target project root.

` + agentPrompt;
  }

  const toolCalls: PipelineAgentResult["toolCalls"] = [];
  let resultText = "";
  let structuredOutput: unknown;
  let requiresUserInput = false;
  let userQuestion: string | undefined;
  let userQuestions: AskUserQuestion[] = [];
  const seenQuestionKeys = new Set<string>();

  // Track tool start times for duration calculation
  const toolStartTimes = new Map<string, number>();

  // Build the full prompt with conversation history
  let userPrompt = agentPrompt + "\n\n";

  // Inject Playwright tool definitions if enabled
  if (enablePlaywrightTools) {
    userPrompt += "## Playwright\n\n";
    userPrompt += `${PLAYWRIGHT_TOOL_SUMMARY}\n\n`;
  }

  if (conversationHistory.length > 0) {
    userPrompt += "## Conversation History\n\n";
    for (const msg of conversationHistory) {
      userPrompt += `**${msg.role === "user" ? "User" : "Assistant"}:** ${msg.content}\n\n`;
    }
  }

  onPrompt?.(userPrompt);

  // Wrap execution in try/finally to ensure browser cleanup
  let thinkingInterval: ReturnType<typeof setInterval> | null = null;
  // Collect stderr output for diagnostics on failure
  const stderrBuffer: string[] = [];
  let promptStream: ReturnType<typeof createPromptStream> | null = null;
  try {
    promptStream = createPromptStream(userPrompt);
    const q = query({
      prompt: promptStream.prompt,
      options: buildClaudeCodeOptions({
        maxTurns,
        // Pass model to SDK if specified (override or from frontmatter)
        ...(effectiveModel && { model: effectiveModel }),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // Set working directory for agent if target project path is provided
        ...(targetProjectPath && { cwd: targetProjectPath }),
        // Capture stderr for debugging agent failures
        stderr: (data: string) => {
          stderrBuffer.push(data);
        },
        // Hook callbacks for tool events
        hooks: (toolCallbacks || enablePlaywrightTools) ? {
          PreToolUse: [{
            hooks: [async (input) => {
              if (input.hook_event_name === "PreToolUse") {
                toolStartTimes.set(input.tool_use_id, Date.now());
                toolCallbacks?.onToolStart?.(input.tool_name, input.tool_input, input.tool_use_id);
                toolCallbacks?.onStatusUpdate?.(formatStatusAction(input.tool_name, input.tool_input));

                await ensureLocalClaudeForToolInput(
                  input.tool_name,
                  input.tool_input,
                  targetProjectPath
                );

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
                  if (toolInput?.questions) {
                    // Deduplicate: only add questions we haven't seen before
                    for (const q of toolInput.questions) {
                      const key = `${q.header}:${q.question}`;
                      if (!seenQuestionKeys.has(key)) {
                        seenQuestionKeys.add(key);
                        userQuestions.push(q);
                      }
                    }
                    console.log(`[Agent] User input required: ${userQuestions.length} unique question(s)`);
                  }
                  toolCalls.push({
                    name: input.tool_name,
                    args: input.tool_input,
                    result: "Questions sent to user. Waiting for response.",
                  });
                  // Stop the agent here - don't let it continue and potentially call again
                  return {
                    continue: false,
                    tool_result: "Questions have been sent to the user. Please wait for their response before continuing.",
                  };
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
      }),
    });

  // Process agent messages
  const startTime = Date.now();
  let lastActivityTime = Date.now();

  // Periodic "thinking" status updates during long gaps
  thinkingInterval = toolCallbacks ? setInterval(() => {
    const idleTime = Date.now() - lastActivityTime;
    if (idleTime > 30000) { // 30 seconds of no activity
      toolCallbacks.onStatusUpdate?.("Analyzing...");
    }
  }, 15000) : null; // Check every 15 seconds

  const processAgent = async () => {
    let turnCount = 0;
    for await (const msg of q) {
      lastActivityTime = Date.now(); // Update activity time on any message

      // Handle streaming chunks if callback provided
      if (msg.type === "assistant" && onStreamChunk) {
        // The SDK might provide partial content
        if ("content" in msg && typeof msg.content === "string") {
          onStreamChunk(msg.content);
        }
      }

      // Track and log turn progress
      if (msg.type === "assistant") {
        turnCount++;
        console.log(`[Agent] ${agentName} turn ${turnCount}/${maxTurns}`);

        // Verbose: log agent message content
        if (VERBOSE && "content" in msg) {
          const content = msg.content as string;
          logVerbose("Agent", `${agentName} turn ${turnCount}`, {
            contentLength: `${content?.length || 0} chars`,
            preview: content?.slice(0, 300),
          });
        }
      }

      if (msg.type === "result") {
        promptStream?.close();
        const result = msg as SDKResultMessage;
        if (result.subtype === "success") {
          resultText = result.result;
          structuredOutput = result.structured_output;
          // Log token usage if available
          if ("usage" in result && result.usage) {
            const usage = result.usage as { input_tokens?: number; output_tokens?: number };
            console.log(`[Agent] ${agentName} tokens: input=${usage.input_tokens ?? "?"}, output=${usage.output_tokens ?? "?"}`);
          }

          // Verbose: log agent completion details
          if (VERBOSE) {
            logVerbose("Agent", `${agentName} completed`, {
              replyLength: `${resultText?.length || 0} chars`,
              hasStructuredOutput: !!structuredOutput,
              historyMessages: conversationHistory.length,
            });
          }
        } else {
          const maxTurnsInfo = result.subtype === "error_max_turns" ? ` (limit: ${maxTurns})` : "";
          throw new Error(
            `Agent error: ${result.subtype}${maxTurnsInfo}${
              "errors" in result ? ` - ${result.errors.join(", ")}` : ""
            }`
          );
        }
      }
    }
  };

  // Process the agent to completion (no timeout - let it run)
  try {
    await processAgent();
    const durationMs = Date.now() - startTime;
    console.log(`[Agent] ${agentName} completed in ${durationMs}ms`);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Log detailed error information for debugging
    console.error(`[Agent] ${agentName} failed after ${durationMs}ms: ${errorMessage}`);

    if (err instanceof Error) {
      // Log stack trace
      if (err.stack) {
        console.error(`[Agent] Stack trace:`, err.stack);
      }

      // Log any additional properties on the error object
      const errorProps = Object.keys(err).filter(k => k !== 'message' && k !== 'stack' && k !== 'name');
      if (errorProps.length > 0) {
        console.error(`[Agent] Error details:`, JSON.stringify(
          errorProps.reduce((acc, k) => ({ ...acc, [k]: (err as unknown as Record<string, unknown>)[k] }), {}),
          null,
          2
        ));
      }
    }

    // Log context for debugging
    console.error(`[Agent] Context: model=${effectiveModel}, cwd=${targetProjectPath || "default"}`);

    // Log stderr output if available
    const stderrOutput = stderrBuffer.join('');
    if (stderrOutput) {
      console.error(`[Agent] stderr output:\n${stderrOutput}`);
    }

    throw err;
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
    structuredOutput,
  };
  } finally {
    promptStream?.close();
    // Cleanup thinking interval
    if (thinkingInterval) {
      clearInterval(thinkingInterval);
    }
    // Cleanup Playwright browser if it was initialized
    if (enablePlaywrightTools) {
      await closeBrowser();
    }
  }
}

/**
 * Run a pipeline agent with a user message (for multi-turn QA)
 *
 * @deprecated Use V2Session.send() from session.ts instead.
 * QA phase has been migrated to V2 sessions which handle conversation
 * history automatically.
 */
export async function runPipelineAgentWithMessage(
  agentName: AgentName,
  userMessage: string,
  previousHistory: ConversationMessage[] = [],
  onStreamChunk?: (chunk: string) => void,
  targetProjectPath?: string,
  maxTurns?: number,
  toolCallbacks?: ToolEventCallbacks,
  onPrompt?: (prompt: string) => void,
  isNewProject?: boolean
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
    isNewProject,
    maxTurns,
    toolCallbacks,
    onPrompt,
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
 *
 * @deprecated Use createV2Session from session.ts instead.
 * This function is kept for backwards compatibility with parallel-explorer.ts
 * which may still use it.
 */
export async function runPipelineAgent(
  agentName: AgentName,
  initialPrompt: string,
  onStreamChunk?: (chunk: string) => void,
  targetProjectPath?: string,
  maxTurns?: number,
  toolCallbacks?: ToolEventCallbacks,
  playwrightAgentOptions?: PlaywrightAgentOptions,
  modelOverride?: string,
  onPrompt?: (prompt: string) => void,
  isNewProject?: boolean
): Promise<PipelineAgentResult> {
  return createPipelineAgent({
    agentName,
    conversationHistory: [{ role: "user", content: initialPrompt }],
    onStreamChunk,
    targetProjectPath,
    isNewProject,
    maxTurns,
    toolCallbacks,
    modelOverride,
    onPrompt,
    ...playwrightAgentOptions,
  });
}
