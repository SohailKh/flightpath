import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { PipelineEvent } from "../types";
import { sendPipelineMessage } from "../lib/api";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

interface PipelineChatProps {
  pipelineId: string;
  events: PipelineEvent[];
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export function PipelineChat({ pipelineId, events }: PipelineChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Convert events to chat messages
  useEffect(() => {
    const chatMessages: ChatMessage[] = [];

    for (const event of events) {
      if (event.type === "user_message" && "content" in event.data) {
        chatMessages.push({
          role: "user",
          content: String(event.data.content),
          timestamp: event.ts,
        });
      } else if (
        event.type === "agent_message" &&
        "content" in event.data &&
        !event.data.streaming
      ) {
        chatMessages.push({
          role: "assistant",
          content: String(event.data.content),
          timestamp: event.ts,
        });
      }
    }

    setMessages(chatMessages);
  }, [events]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isSending) return;

    const message = input.trim();
    setInput("");
    setIsSending(true);

    try {
      await sendPipelineMessage(pipelineId, message);
    } catch (err) {
      console.error("Failed to send message:", err);
      // Restore input on error
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

  // Check if we're waiting for user input
  const lastAgentEvent = [...events]
    .reverse()
    .find((e) => e.type === "agent_message");
  const waitingForInput =
    lastAgentEvent &&
    "requiresUserInput" in lastAgentEvent.data &&
    lastAgentEvent.data.requiresUserInput;

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <Card className="flex-1 overflow-hidden flex flex-col">
        <CardContent className="flex-1 overflow-y-auto py-4">
          <div className="space-y-4">
            {messages.length === 0 && (
              <div className="text-gray-400 text-sm text-center py-8">
                Starting feature discovery...
              </div>
            )}
            {messages.map((msg, i) => (
              <ChatBubble key={i} message={msg} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        </CardContent>
      </Card>

      {/* Input area */}
      <div className="flex gap-2 mt-4">
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

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div
      className={cn("flex", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-4 py-2",
          isUser
            ? "bg-blue-600 text-white"
            : "bg-gray-100 text-gray-900"
        )}
      >
        <div className="text-sm whitespace-pre-wrap">{message.content}</div>
        <div
          className={cn(
            "text-xs mt-1",
            isUser ? "text-blue-200" : "text-gray-400"
          )}
        >
          {new Date(message.timestamp).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
