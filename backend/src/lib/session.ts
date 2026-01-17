/**
 * V2 Claude Agent SDK Session Management
 *
 * Provides cleaner multi-turn conversation management using the V2 session API.
 * Sessions automatically track conversation history and can be resumed by ID.
 *
 * Workarounds for V2 limitations:
 * - cwd: Embed in tool inputs so file ops resolve to the intended project root
 * - systemPrompt: Embedded in first user message since V2 doesn't have systemPrompt option
 */

import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKResultMessage,
  type HookInput,
  type HookJSONOutput,
  type HookCallbackMatcher,
  type HookEvent,
  type PreToolUseHookInput,
  type PostToolUseHookInput,
  type PostToolUseFailureHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadProjectConfig, generateProjectContext } from "./project-config";
import { rewriteClaudeCommand, rewriteClaudeFilePath } from "./claude-paths";
import type {
  AgentName,
  ToolEventCallbacks,
  AskUserQuestion,
  AskUserInputRequest,
} from "./agent";
import { notifyTelegramQuestions, notifyTelegramUserInput } from "./telegram";
import { ensureLocalClaudeForToolInput, ensureProjectClaudeLayout } from "./claude-scaffold";

// Flightpath root directory - resolved at module load time
const FLIGHTPATH_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * Session state tracking
 */
export interface SessionState {
  sessionId: string;
  model: string;
  cwd: string;
  agentName: AgentName;
  createdAt: Date;
}

/**
 * Options for creating a V2 session
 */
export interface V2SessionOptions {
  agentName: AgentName;
  /** Pipeline ID for notifications */
  pipelineId?: string;
  /** Path to target project for context injection */
  targetProjectPath?: string;
  /** Storage ID for centralized .claude paths */
  claudeStorageId?: string;
  /** Override for .claude storage root */
  claudeStorageRootOverride?: string;
  /** Treat target as a new project (skip file ops) */
  isNewProject?: boolean;
  /** Callbacks for tool activity events */
  toolCallbacks?: ToolEventCallbacks;
  /** Override the model specified in agent frontmatter */
  modelOverride?: string;
  /** Maximum number of turns before stopping */
  maxTurns?: number;
}

/**
 * Result from a session turn
 */
export interface V2SessionTurnResult {
  /** The assistant's reply text */
  reply: string;
  /** Session ID for resumption */
  sessionId: string;
  /** Tool calls made during this turn */
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  /** Whether the agent is waiting for user input */
  requiresUserInput: boolean;
  /** Questions for the user (if requiresUserInput is true) */
  userQuestions?: AskUserQuestion[];
  /** Structured output from the agent */
  structuredOutput?: unknown;
  /** Token usage statistics */
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Total cost for the turn (USD), if provided by the SDK */
  totalCostUsd?: number;
  /** Total turns recorded by the SDK for this session */
  totalTurns?: number;
}

/**
 * Active session wrapper
 */
export interface V2Session {
  /** Session ID for persistence/resumption */
  sessionId: string;
  /** The system prompt to prepend to the first message */
  systemPrompt: string;
  /** Working directory for this session (used for tool path resolution) */
  cwd?: string;
  /** Send a message and get a response */
  send(message: string): Promise<V2SessionTurnResult>;
  /** Close the session and clean up resources */
  close(): Promise<void>;
}

/**
 * Parse frontmatter from agent markdown file
 */
async function parseAgentFrontmatter(
  agentName: AgentName
): Promise<Record<string, unknown>> {
  const agentsDir = join(FLIGHTPATH_ROOT, "src", "agents");
  const promptPath = join(agentsDir, `${agentName}.md`);

  if (!existsSync(promptPath)) {
    return {};
  }

  const content = await readFile(promptPath, "utf-8");

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
 * Load an agent prompt from the agents directory
 */
async function loadAgentPrompt(
  agentName: AgentName,
  targetProjectPath?: string
): Promise<string> {
  const agentsDir = join(FLIGHTPATH_ROOT, "src", "agents");
  const promptPath = join(agentsDir, `${agentName}.md`);

  if (!existsSync(promptPath)) {
    throw new Error(`Agent prompt not found: ${promptPath}`);
  }

  const rawContent = await readFile(promptPath, "utf-8");

  // Extract content after frontmatter
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
 * Map short model names to full SDK model identifiers
 */
function mapModelName(shortName?: string): string {
  if (!shortName) return "claude-opus-4-5-20251101";
  const modelMap: Record<string, string> = {
    haiku: "claude-haiku-3-5-20241022",
    sonnet: "claude-sonnet-4-5-20250929",
    opus: "claude-opus-4-5-20251101",
  };
  return modelMap[shortName.toLowerCase()] || shortName;
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
    case "AskUserQuestion": {
      const questions = args.questions as Array<{ header?: string }> | undefined;
      if (questions?.[0]?.header) return `Asking: ${questions[0].header}`;
      return "Asking user...";
    }
    case "AskUserInput": {
      const header = args.header as string | undefined;
      if (header) return `Requesting input: ${header}`;
      return "Requesting user input...";
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

function resolveUserPath(value: string, cwd: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (isAbsolute(trimmed)) {
    return trimmed;
  }
  return resolve(cwd, trimmed);
}

function shouldRewritePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("http://") || value.startsWith("https://")) return false;
  if (value.startsWith("file://")) return false;
  return true;
}

const CLAUDE_ARTIFACT_FILES = new Set([
  "feature-spec.json",
  "feature-spec.v3.json",
  "feature-understanding.json",
  "smoke-tests.json",
  "feature-map.json",
]);

// These files should always be at the root of .claude/{storageId}/, not in a subdirectory
const CLAUDE_ROOT_LEVEL_FILES = new Set([
  "feature-understanding.json",
  "feature-map.json",
]);

function extractFeaturePrefixFromContent(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const match = content.match(/"featurePrefix"\s*:\s*"([^"]+)"/);
  const prefix = match?.[1]?.trim();
  return prefix ? prefix : null;
}

function normalizeArtifactPath(rawPath: string, content?: unknown): string {
  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.includes("/.claude/") || normalized.startsWith(".claude/")) {
    return rawPath;
  }

  const base = normalized.split("/").pop() || normalized;
  if (!CLAUDE_ARTIFACT_FILES.has(base)) return rawPath;

  // Root-level files (feature-understanding.json, feature-map.json) should always
  // go directly to .claude/{filename}, not .claude/{prefix}/{filename}
  if (CLAUDE_ROOT_LEVEL_FILES.has(base)) {
    return `.claude/${base}`;
  }

  let prefix: string | null = null;
  const dir = normalized.slice(0, normalized.length - base.length).replace(/\/$/, "");
  if (dir && dir !== "." && dir !== "..") {
    const parts = dir.split("/");
    prefix = parts[parts.length - 1];
  }

  if (!prefix) {
    prefix = extractFeaturePrefixFromContent(content);
  }

  if (!prefix) return rawPath;

  return `.claude/${prefix}/${base}`;
}

function rewriteBashCommand(command: string, cwd?: string): string {
  const trimmed = command.trim();
  if (!trimmed) return command;
  if (!cwd) return command;
  const safeCwd = cwd.replace(/"/g, '\\"');
  return `cd "${safeCwd}" && ${command}`;
}

function resolveToolInput(
  toolName: string,
  toolInput: unknown,
  cwd?: string,
  claudeStorageId?: string,
  claudeStorageRootOverride?: string
): { resolvedInput: unknown; updatedInput?: Record<string, unknown> } {
  if (!toolInput || typeof toolInput !== "object") {
    return { resolvedInput: toolInput };
  }

  const input = toolInput as Record<string, unknown>;
  let updated = false;
  const next: Record<string, unknown> = { ...input };

  const updatePathKey = (key: string, content?: unknown) => {
    const raw = input[key];
    if (typeof raw !== "string" || !shouldRewritePath(raw)) return;
    const normalizedPath =
      key === "file_path" ? normalizeArtifactPath(raw, content) : raw;
    const claudeRewritten = rewriteClaudeFilePath(
      normalizedPath,
      claudeStorageId,
      claudeStorageRootOverride
    );
    const resolved = cwd ? resolveUserPath(claudeRewritten, cwd) : claudeRewritten;
    if (resolved !== raw) {
      next[key] = resolved;
      updated = true;
    }
  };

  switch (toolName) {
    case "Read":
    case "Edit":
      updatePathKey("file_path");
      break;
    case "Write":
      updatePathKey("file_path", input.content);
      break;
    case "Glob":
      updatePathKey("pattern");
      break;
    case "Grep":
      updatePathKey("path");
      break;
    case "LS":
    case "Tree":
      updatePathKey("path");
      updatePathKey("directory");
      break;
    case "Bash": {
      const rawCommand = input.command;
      if (typeof rawCommand === "string") {
        const claudeRewritten = rewriteClaudeCommand(
          rawCommand,
          claudeStorageId,
          claudeStorageRootOverride
        );
        const wrapped = rewriteBashCommand(claudeRewritten, cwd);
        if (wrapped !== rawCommand) {
          next.command = wrapped;
          updated = true;
        }
      }
      break;
    }
    default:
      updatePathKey("path");
      updatePathKey("directory");
      break;
  }

  if (!updated) {
    return { resolvedInput: toolInput };
  }

  return { resolvedInput: next, updatedInput: next };
}

/**
 * Build hook configuration for tool interception
 */
function buildHooks(
  toolCallbacks: ToolEventCallbacks | undefined,
  toolStartTimes: Map<string, number>,
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>,
  userQuestions: AskUserQuestion[],
  seenQuestionKeys: Set<string>,
  setRequiresUserInput: (value: boolean) => void,
  pipelineId?: string,
  sessionCwd?: string,
  claudeStorageId?: string,
  claudeStorageRootOverride?: string,
  onAskUserInput?: (request: AskUserInputRequest) => void
): Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined {
  const preToolUseHook = async (
    input: HookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    // Type guard for PreToolUse
    if (input.hook_event_name !== "PreToolUse") {
      return {};
    }
    const preInput = input as PreToolUseHookInput;
    const { resolvedInput, updatedInput } = resolveToolInput(
      preInput.tool_name,
      preInput.tool_input,
      sessionCwd,
      claudeStorageId,
      claudeStorageRootOverride
    );

    await ensureLocalClaudeForToolInput(
      preInput.tool_name,
      resolvedInput,
      sessionCwd
    );

    toolStartTimes.set(preInput.tool_use_id, Date.now());
    toolCallbacks?.onToolStart?.(
      preInput.tool_name,
      resolvedInput,
      preInput.tool_use_id
    );
    toolCallbacks?.onStatusUpdate?.(
      formatStatusAction(preInput.tool_name, resolvedInput)
    );

    // Intercept AskUserQuestion to pause agent
    if (preInput.tool_name === "AskUserQuestion") {
      setRequiresUserInput(true);
      const toolInput = resolvedInput as {
        questions?: AskUserQuestion[];
      };
      if (toolInput?.questions) {
        for (const q of toolInput.questions) {
          const key = `${q.header}:${q.question}`;
          if (!seenQuestionKeys.has(key)) {
            seenQuestionKeys.add(key);
            userQuestions.push(q);
          }
        }
        if (pipelineId) {
          void notifyTelegramQuestions(pipelineId, toolInput.questions, "qa");
        }
      }
      toolCalls.push({
        name: preInput.tool_name,
        args: resolvedInput,
        result: "Questions sent to user.",
      });
      return {
        continue: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Questions have been sent to the user. Please wait for their response.",
        },
      };
    }

    // Intercept AskUserInput to pause agent and collect secrets/files/config
    if (preInput.tool_name === "AskUserInput") {
      setRequiresUserInput(true);
      const toolInput = resolvedInput as AskUserInputRequest;

      // Generate a unique request ID if not provided
      const request: AskUserInputRequest = {
        id: toolInput.id || crypto.randomUUID(),
        header: toolInput.header || "Input Required",
        description: toolInput.description || "",
        fields: toolInput.fields || [],
      };

      // Notify via callback if provided
      if (onAskUserInput) {
        onAskUserInput(request);
      }

      // Notify via Telegram if configured
      if (pipelineId) {
        void notifyTelegramUserInput(pipelineId, request);
      }

      toolCalls.push({
        name: preInput.tool_name,
        args: resolvedInput,
        result: "Input request sent to user. Waiting for response.",
      });

      return {
        continue: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Input request has been sent to the user. Please wait for their response with secrets, files, or configuration values.",
        },
      };
    }

    // Intercept TodoWrite for real-time updates
    if (preInput.tool_name === "TodoWrite") {
      const todoInput = resolvedInput as { todos?: unknown[] };
      if (todoInput?.todos && toolCallbacks?.onTodoUpdate) {
        toolCallbacks.onTodoUpdate(todoInput.todos);
      }
    }
    if (updatedInput) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput,
        },
      };
    }

    return { continue: true };
  };

  const postToolUseHook = async (
    input: HookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUse") {
      return {};
    }
    const postInput = input as PostToolUseHookInput;

    const startTime = toolStartTimes.get(postInput.tool_use_id) || Date.now();
    const durationMs = Date.now() - startTime;
    toolStartTimes.delete(postInput.tool_use_id);
    toolCallbacks?.onToolComplete?.(
      postInput.tool_name,
      postInput.tool_input,
      postInput.tool_use_id,
      postInput.tool_response,
      durationMs
    );

    toolCalls.push({
      name: postInput.tool_name,
      args: postInput.tool_input,
      result: postInput.tool_response,
    });

    return {};
  };

  const postToolUseFailureHook = async (
    input: HookInput,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal }
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PostToolUseFailure") {
      return {};
    }
    const failInput = input as PostToolUseFailureHookInput;

    toolStartTimes.delete(failInput.tool_use_id);
    toolCallbacks?.onToolError?.(
      failInput.tool_name,
      failInput.tool_input,
      failInput.tool_use_id,
      failInput.error
    );

    toolCalls.push({
      name: failInput.tool_name,
      args: failInput.tool_input,
      result: `Error: ${failInput.error}`,
    });

    return {};
  };

  return {
    PreToolUse: [{ hooks: [preToolUseHook] }],
    PostToolUse: [{ hooks: [postToolUseHook] }],
    PostToolUseFailure: [{ hooks: [postToolUseFailureHook] }],
  };
}

/**
 * Create a new V2 session for an agent
 *
 * Note: V2 sessions don't have systemPrompt or cwd options directly.
 * We work around this by:
 * - Rewriting tool inputs to anchor paths under the desired working directory
 * - Embedding system prompt in the first message (caller's responsibility)
 */
export async function createV2Session(
  options: V2SessionOptions
): Promise<V2Session> {
  const {
    agentName,
    pipelineId,
    targetProjectPath,
    claudeStorageId,
    claudeStorageRootOverride,
    isNewProject,
    toolCallbacks,
    modelOverride,
    maxTurns = 50,
  } = options;
  const sessionCwd = targetProjectPath
    ? resolveUserPath(targetProjectPath, process.cwd())
    : undefined;

  // Determine effective model
  const frontmatter = await parseAgentFrontmatter(agentName);
  const declaredModel = frontmatter.model as string | undefined;
  const effectiveModel = mapModelName(modelOverride || declaredModel);

  if (targetProjectPath) {
    await ensureProjectClaudeLayout(targetProjectPath);
  }

  // Load system prompt - will be embedded in first message
  let systemPrompt = await loadAgentPrompt(agentName, targetProjectPath);

  // Inject context for new projects
  const treatAsNewProject = isNewProject ?? !targetProjectPath;
  if (treatAsNewProject) {
    const cwd = sessionCwd || process.cwd();
    systemPrompt =
      `## Context
This is a NEW PROJECT - there is no existing codebase to analyze.
Skip all file operations (git, Read, Glob, Grep, Bash) and proceed directly to interviewing the user about what they want to build.

**Working Directory:** \`${cwd}\`
For pipeline artifacts (feature-spec.v3.json, smoke-tests.json, feature-map.json), always write under \`.claude/{featurePrefix}\` (the \`.claude\` path is remapped to backend storage). Do not write those files into the target project root.

` + systemPrompt;
  }

  if (!treatAsNewProject && sessionCwd) {
    systemPrompt = `## Working Directory\n\n\`${sessionCwd}\`\n\n` + systemPrompt;
  }

  console.log(
    `[Session] Creating V2 session for ${agentName} (model: ${effectiveModel})`
  );

  // State tracking for the session
  const toolStartTimes = new Map<string, number>();
  const toolCalls: Array<{ name: string; args: unknown; result: unknown }> = [];
  const userQuestions: AskUserQuestion[] = [];
  const seenQuestionKeys = new Set<string>();
  let requiresUserInput = false;
  let capturedSessionId: string | undefined;
  let isFirstMessage = true;

  const setRequiresUserInput = (value: boolean) => {
    requiresUserInput = value;
  };

  // Build environment with PWD set for working directory
  const sessionEnv: Record<string, string | undefined> = {
    ...process.env,
  };
  if (sessionCwd) {
    sessionEnv.PWD = sessionCwd;
  }

  // Create the V2 session
  const session = unstable_v2_createSession({
    model: effectiveModel,
    env: sessionEnv,
    permissionMode: "bypassPermissions",
    hooks: buildHooks(
      toolCallbacks,
      toolStartTimes,
      toolCalls,
      userQuestions,
      seenQuestionKeys,
      setRequiresUserInput,
      pipelineId,
      sessionCwd,
      claudeStorageId,
      claudeStorageRootOverride
    ),
  });

  // Return session wrapper
  return {
    get sessionId() {
      return capturedSessionId || "";
    },

    systemPrompt,
    cwd: sessionCwd,

    async send(message: string): Promise<V2SessionTurnResult> {
      // Reset per-turn state
      toolCalls.length = 0;
      userQuestions.length = 0;
      seenQuestionKeys.clear();
      requiresUserInput = false;

      // For the first message, prepend system prompt
      let fullMessage = message;
      if (isFirstMessage) {
        fullMessage = `${systemPrompt}\n\n---\n\n${message}`;
        isFirstMessage = false;
      }

      await session.send(fullMessage);

      let resultText = "";
      let structuredOutput: unknown;
      let usage: { input_tokens?: number; output_tokens?: number } | undefined;
      let totalCostUsd: number | undefined;
      let totalTurns: number | undefined;

      for await (const msg of session.stream()) {
        // Capture session ID from first message
        if (!capturedSessionId && msg.session_id) {
          capturedSessionId = msg.session_id;
        }

        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success") {
            resultText = result.result;
            structuredOutput = result.structured_output;
            if ("usage" in result && result.usage) {
              usage = result.usage as typeof usage;
            }
            totalCostUsd = result.total_cost_usd;
            totalTurns = result.num_turns;
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
        sessionId: capturedSessionId || "",
        toolCalls: [...toolCalls],
        requiresUserInput,
        userQuestions: userQuestions.length > 0 ? [...userQuestions] : undefined,
        structuredOutput,
        usage,
        totalCostUsd,
        totalTurns,
      };
    },

    async close(): Promise<void> {
      session.close();
    },
  };
}

/**
 * Resume an existing V2 session by ID
 */
export async function resumeV2Session(
  sessionId: string,
  options: V2SessionOptions
): Promise<V2Session> {
  const {
    agentName,
    pipelineId,
    targetProjectPath,
    toolCallbacks,
    modelOverride,
    maxTurns = 50,
  } = options;
  const sessionCwd = targetProjectPath
    ? resolveUserPath(targetProjectPath, process.cwd())
    : undefined;
  const claudeStorageId = options.claudeStorageId;
  const claudeStorageRootOverride = options.claudeStorageRootOverride;

  // Determine effective model
  const frontmatter = await parseAgentFrontmatter(agentName);
  const declaredModel = frontmatter.model as string | undefined;
  const effectiveModel = mapModelName(modelOverride || declaredModel);

  if (targetProjectPath) {
    await ensureProjectClaudeLayout(targetProjectPath);
  }

  console.log(
    `[Session] Resuming V2 session ${sessionId.slice(0, 8)}... for ${agentName}`
  );

  // State tracking
  const toolStartTimes = new Map<string, number>();
  const toolCalls: Array<{ name: string; args: unknown; result: unknown }> = [];
  const userQuestions: AskUserQuestion[] = [];
  const seenQuestionKeys = new Set<string>();
  let requiresUserInput = false;

  const setRequiresUserInput = (value: boolean) => {
    requiresUserInput = value;
  };

  // Build environment with PWD set
  const sessionEnv: Record<string, string | undefined> = {
    ...process.env,
  };
  if (sessionCwd) {
    sessionEnv.PWD = sessionCwd;
  }

  // Resume the session
  const session = unstable_v2_resumeSession(sessionId, {
    model: effectiveModel,
    env: sessionEnv,
    permissionMode: "bypassPermissions",
    hooks: buildHooks(
      toolCallbacks,
      toolStartTimes,
      toolCalls,
      userQuestions,
      seenQuestionKeys,
      setRequiresUserInput,
      pipelineId,
      sessionCwd,
      claudeStorageId,
      claudeStorageRootOverride
    ),
  });

  return {
    sessionId,

    systemPrompt: "", // Already embedded in session history
    cwd: sessionCwd,

    async send(message: string): Promise<V2SessionTurnResult> {
      // Reset per-turn state
      toolCalls.length = 0;
      userQuestions.length = 0;
      seenQuestionKeys.clear();
      requiresUserInput = false;

      await session.send(message);

      let resultText = "";
      let structuredOutput: unknown;
      let usage: { input_tokens?: number; output_tokens?: number } | undefined;
      let totalCostUsd: number | undefined;
      let totalTurns: number | undefined;

      for await (const msg of session.stream()) {
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          if (result.subtype === "success") {
            resultText = result.result;
            structuredOutput = result.structured_output;
            if ("usage" in result && result.usage) {
              usage = result.usage as typeof usage;
            }
            totalCostUsd = result.total_cost_usd;
            totalTurns = result.num_turns;
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
        sessionId,
        toolCalls: [...toolCalls],
        requiresUserInput,
        userQuestions: userQuestions.length > 0 ? [...userQuestions] : undefined,
        structuredOutput,
        usage,
        totalCostUsd,
        totalTurns,
      };
    },

    async close(): Promise<void> {
      session.close();
    },
  };
}
