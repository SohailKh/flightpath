import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

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
  | "feature-doctor";

/**
 * Message format for conversation history
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
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
}

/**
 * Extended result for pipeline agents
 */
export interface PipelineAgentResult extends AgentResult {
  conversationHistory: ConversationMessage[];
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  requiresUserInput: boolean;
  userQuestion?: string;
}

/**
 * Load an agent prompt from the agents directory
 */
async function loadAgentPrompt(agentName: AgentName): Promise<string> {
  const agentsDir = join(process.cwd(), "backend", "src", "agents");
  const promptPath = join(agentsDir, `${agentName}.md`);

  if (!existsSync(promptPath)) {
    throw new Error(`Agent prompt not found: ${promptPath}`);
  }

  const content = await readFile(promptPath, "utf-8");

  // Extract just the content after the frontmatter
  const frontmatterEnd = content.indexOf("---", 4);
  if (frontmatterEnd === -1) {
    return content;
  }

  return content.substring(frontmatterEnd + 3).trim();
}

/**
 * Parse frontmatter from agent markdown file
 */
async function parseAgentFrontmatter(
  agentName: AgentName
): Promise<Record<string, unknown>> {
  const agentsDir = join(process.cwd(), "backend", "src", "agents");
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
 * Creates an agent runner for a specific pipeline agent with full configuration.
 * Supports multi-turn conversations and streaming.
 */
export async function createPipelineAgent(
  options: AgentWithPromptOptions
): Promise<PipelineAgentResult> {
  const { agentName, conversationHistory = [], maxTurns = 10, onStreamChunk } = options;

  const requestId = crypto.randomUUID();
  const systemPrompt = await loadAgentPrompt(agentName);
  const toolCalls: PipelineAgentResult["toolCalls"] = [];
  let resultText = "";
  let requiresUserInput = false;
  let userQuestion: string | undefined;

  // Build the full prompt with conversation history
  let fullPrompt = systemPrompt + "\n\n";

  if (conversationHistory.length > 0) {
    fullPrompt += "## Conversation History\n\n";
    for (const msg of conversationHistory) {
      fullPrompt += `**${msg.role === "user" ? "User" : "Assistant"}:** ${msg.content}\n\n`;
    }
  }

  const q = query({
    prompt: fullPrompt,
    options: {
      maxTurns,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Tools will be handled by Claude Code's built-in tool execution
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

    // Handle tool use detection (for AskUserQuestion)
    if (msg.type === "assistant" && "toolUse" in msg) {
      const toolUse = msg.toolUse as { name: string; input: unknown } | undefined;
      if (toolUse?.name === "AskUserQuestion") {
        requiresUserInput = true;
        const input = toolUse.input as { question?: string } | undefined;
        userQuestion = input?.question;
        toolCalls.push({
          name: toolUse.name,
          args: toolUse.input,
          result: null,
        });
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
  };
}

/**
 * Run a pipeline agent with a user message (for multi-turn QA)
 */
export async function runPipelineAgentWithMessage(
  agentName: AgentName,
  userMessage: string,
  previousHistory: ConversationMessage[] = [],
  onStreamChunk?: (chunk: string) => void
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
  });
}

/**
 * Run a pipeline agent with just a prompt (for starting a phase)
 */
export async function runPipelineAgent(
  agentName: AgentName,
  initialPrompt: string,
  onStreamChunk?: (chunk: string) => void
): Promise<PipelineAgentResult> {
  return createPipelineAgent({
    agentName,
    conversationHistory: [{ role: "user", content: initialPrompt }],
    onStreamChunk,
  });
}
