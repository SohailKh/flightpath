import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export interface AgentResult {
  reply: string;
  requestId: string;
}

export interface AgentRunner {
  run(message: string): Promise<AgentResult>;
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
