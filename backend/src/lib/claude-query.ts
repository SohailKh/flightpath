import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_SETTING_SOURCES: Options["settingSources"] = ["user", "project"];

export function buildClaudeCodeOptions(params: {
  cwd?: string;
  maxTurns?: number;
  model?: string;
  hooks?: Options["hooks"];
  mcpServers?: Options["mcpServers"];
  permissionMode?: Options["permissionMode"];
  allowDangerouslySkipPermissions?: boolean;
  tools?: Options["tools"];
  settingSources?: Options["settingSources"];
  systemPromptAppend?: string;
  stderr?: Options["stderr"];
  includePartialMessages?: boolean;
}): Options {
  const systemPrompt = params.systemPromptAppend
    ? { type: "preset", preset: "claude_code", append: params.systemPromptAppend }
    : { type: "preset", preset: "claude_code" };

  return {
    tools: params.tools ?? { type: "preset", preset: "claude_code" },
    systemPrompt,
    settingSources: params.settingSources ?? DEFAULT_SETTING_SOURCES,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.hooks ? { hooks: params.hooks } : {}),
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
    ...(params.allowDangerouslySkipPermissions !== undefined
      ? { allowDangerouslySkipPermissions: params.allowDangerouslySkipPermissions }
      : {}),
    ...(params.stderr ? { stderr: params.stderr } : {}),
    ...(params.includePartialMessages !== undefined
      ? { includePartialMessages: params.includePartialMessages }
      : {}),
  };
}

export function createPromptStream(message: string): {
  prompt: AsyncIterable<SDKUserMessage>;
  close: () => void;
} {
  let resolveClose: (() => void) | null = null;
  let closed = false;

  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  const prompt = (async function* () {
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text: message }],
      },
    } satisfies SDKUserMessage;
    await closePromise;
  })();

  return {
    prompt,
    close: () => {
      if (closed) return;
      closed = true;
      resolveClose?.();
    },
  };
}
