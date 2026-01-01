import { useState } from "react";
import type { PipelineEvent } from "../types";
import { sendPipelineMessage } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ActivityStream } from "./ActivityStream";
import { ResponseLog } from "./ResponseLog";

interface PipelineChatProps {
  pipelineId: string;
  events: PipelineEvent[];
}

export function PipelineChat({ pipelineId, events }: PipelineChatProps) {
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [answeredQuestions, setAnsweredQuestions] = useState<Set<string>>(new Set());

  const handleSend = async () => {
    if (!input.trim() || isSending) return;

    const message = input.trim();
    setInput("");
    setIsSending(true);

    try {
      await sendPipelineMessage(pipelineId, message);
    } catch (err) {
      console.error("Failed to send message:", err);
      setInput(message);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuestionSubmit = async (answers: Record<string, string | string[]>, timestamp: string) => {
    const formattedAnswers = Object.entries(answers)
      .map(([header, value]) => {
        if (Array.isArray(value)) {
          return `${header}:\n${value.map(v => `- ${v}`).join("\n")}`;
        }
        return `${header}: ${value}`;
      })
      .join("\n\n");

    setIsSending(true);
    setAnsweredQuestions(prev => new Set(prev).add(timestamp));

    try {
      await sendPipelineMessage(pipelineId, formattedAnswers);
    } catch (err) {
      console.error("Failed to send answers:", err);
      setAnsweredQuestions(prev => {
        const next = new Set(prev);
        next.delete(timestamp);
        return next;
      });
    } finally {
      setIsSending(false);
    }
  };

  const lastAgentEvent = [...events]
    .reverse()
    .find((e) => e.type === "agent_message");
  const waitingForInput =
    lastAgentEvent &&
    "requiresUserInput" in lastAgentEvent.data &&
    lastAgentEvent.data.requiresUserInput;

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Side-by-side content area */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Activity Stream - Left */}
        <div className="w-1/2">
          <ActivityStream events={events} currentPhase="qa" />
        </div>

        {/* Response Log - Right */}
        <div className="w-1/2">
          <ResponseLog
            events={events}
            pipelineId={pipelineId}
            onQuestionSubmit={handleQuestionSubmit}
            answeredQuestions={answeredQuestions}
            isSending={isSending}
          />
        </div>
      </div>

      {/* Input area */}
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            waitingForInput
              ? "Type your response..."
              : "Waiting for agent question..."
          }
          disabled={isSending}
          className="flex-1"
        />
        <Button onClick={handleSend} disabled={!input.trim() || isSending}>
          {isSending ? "Sending..." : "Send"}
        </Button>
      </div>
    </div>
  );
}
