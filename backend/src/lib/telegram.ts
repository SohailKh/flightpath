import type { AskUserQuestion } from "./agent";

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";
const MAX_MESSAGE_LENGTH = 3800;

function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseChatIds(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getTelegramConfig(): {
  token?: string;
  chatIds: string[];
  webhookSecret?: string;
} {
  return {
    token: normalizeEnvValue(process.env.TELEGRAM_BOT_TOKEN),
    chatIds: parseChatIds(process.env.TELEGRAM_CHAT_ID),
    webhookSecret: normalizeEnvValue(process.env.TELEGRAM_WEBHOOK_SECRET),
  };
}

export function isTelegramChatAllowed(chatId: string | number): boolean {
  const { chatIds } = getTelegramConfig();
  if (chatIds.length === 0) return true;
  return chatIds.includes(String(chatId));
}

function formatQuestionBlock(question: AskUserQuestion, index: number): string {
  const lines: string[] = [];
  const header = question.header || `Question ${index + 1}`;
  const selectionHint = question.options?.length
    ? question.multiSelect
      ? "Select one or more"
      : "Select one"
    : "Reply with your answer";
  lines.push(`${index + 1}) ${header} (${selectionHint})`);
  if (question.question) {
    lines.push(question.question);
  }
  if (question.options?.length) {
    const optionKeys = question.options.map((_, optionIndex) =>
      formatOptionKey(optionIndex)
    );
    lines.push(`Choices: ${optionKeys.join(", ")}`);
    for (const [optionIndex, option] of question.options.entries()) {
      const detail = option.description ? ` - ${option.description}` : "";
      lines.push(`${formatOptionKey(optionIndex)}) ${option.label}${detail}`);
    }
  }
  return lines.join("\n");
}

function formatOptionKey(index: number): string {
  if (index < 26) {
    return String.fromCharCode(65 + index);
  }
  return `#${index + 1}`;
}

function formatQuestionMessage(
  pipelineId: string,
  questions: AskUserQuestion[],
  phase?: string
): string {
  const lines: string[] = [];
  const phaseLabel = phase ? `, phase: ${phase}` : "";
  const shortId = pipelineId.slice(0, 8);
  lines.push(`[Flightpath] Input needed (pipeline ${shortId}${phaseLabel})`);
  lines.push("");
  if (questions.length === 0) {
    lines.push("The agent requested input, but no questions were provided.");
  } else {
    questions.forEach((question, index) => {
      lines.push(formatQuestionBlock(question, index));
      lines.push("");
    });
  }
  if (questions.length > 0) {
    lines.push("Reply format:");
    const templateLines = questions.map((question, index) => {
      const optionLabels = question.options?.length
        ? question.options.map((_, optionIndex) => formatOptionKey(optionIndex)).join(",")
        : "text";
      const multiHint = question.multiSelect ? " (multi)" : "";
      return `${index + 1}=${optionLabels}${multiHint}`;
    });
    lines.push(templateLines.join("\n"));
  }
  lines.push("");
  lines.push("Use commas for multi-select answers, e.g. `2=A,C`.");
  lines.push("For file requests, reply with the path and say when it's ready.");

  const text = lines.join("\n").trim();
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_MESSAGE_LENGTH - 3) + "...";
}

async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string
): Promise<void> {
  const url = `${TELEGRAM_API_BASE}${token}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: { force_reply: true },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram send failed: ${response.status} ${errorText}`);
  }
}

export async function notifyTelegramQuestions(
  pipelineId: string,
  questions: AskUserQuestion[],
  phase?: string
): Promise<void> {
  const { token, chatIds } = getTelegramConfig();
  if (!token || chatIds.length === 0) return;

  const text = formatQuestionMessage(pipelineId, questions, phase);
  try {
    await Promise.all(chatIds.map((chatId) => sendTelegramMessage(token, chatId, text)));
  } catch (error) {
    console.warn(
      `[Telegram] Failed to send question notification: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
