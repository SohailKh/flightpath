import { useRef, useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { PipelineEvent, AskUserQuestion, Requirement, ToolEventData } from "../types";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { QuestionCard } from "./QuestionCard";

interface ResponseLogProps {
  events: PipelineEvent[];
  pipelineId?: string;
  requirements?: Requirement[];
  onQuestionSubmit?: (answers: Record<string, string | string[]>, timestamp: string) => void;
  answeredQuestions?: Set<string>;
  isSending?: boolean;
}

interface LogEntry {
  type: "message" | "status" | "requirement" | "phase";
  role?: "user" | "assistant";
  content: string;
  timestamp: string;
  userQuestions?: AskUserQuestion[];
  requirementId?: string;
  requirementStatus?: string;
  phase?: string;
}

export function ResponseLog({
  events,
  requirements = [],
  onQuestionSubmit,
  answeredQuestions = new Set(),
  isSending = false,
}: ResponseLogProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const lastQuestionTsRef = useRef<string | null>(null);
  const [, forceRender] = useState({});

  // Convert events to log entries
  const logEntries = useMemo(() => {
    const entries: LogEntry[] = [];

    for (const event of events) {
      if (event.type === "user_message" && "content" in event.data) {
        entries.push({
          type: "message",
          role: "user",
          content: String(event.data.content),
          timestamp: event.ts,
        });
      } else if (
        event.type === "agent_message" &&
        "content" in event.data &&
        !event.data.streaming
      ) {
        entries.push({
          type: "message",
          role: "assistant",
          content: String(event.data.content),
          timestamp: event.ts,
          userQuestions: event.data.userQuestions as AskUserQuestion[] | undefined,
        });
      } else if (event.type === "agent_response" && "content" in event.data) {
        entries.push({
          type: "message",
          role: "assistant",
          content: String(event.data.content),
          timestamp: event.ts,
        });
      } else if (event.type === "status_update" && "message" in event.data) {
        entries.push({
          type: "status",
          content: String(event.data.message),
          timestamp: event.ts,
        });
      } else if (event.type === "requirement_started" && "requirementId" in event.data) {
        const req = requirements.find((r) => r.id === event.data.requirementId);
        entries.push({
          type: "requirement",
          content: req?.title || String(event.data.requirementId),
          timestamp: event.ts,
          requirementId: String(event.data.requirementId),
          requirementStatus: "started",
        });
      } else if (event.type === "requirement_completed" && "requirementId" in event.data) {
        const req = requirements.find((r) => r.id === event.data.requirementId);
        entries.push({
          type: "requirement",
          content: req?.title || String(event.data.requirementId),
          timestamp: event.ts,
          requirementId: String(event.data.requirementId),
          requirementStatus: "completed",
        });
      } else if (event.type === "requirement_failed" && "requirementId" in event.data) {
        const req = requirements.find((r) => r.id === event.data.requirementId);
        entries.push({
          type: "requirement",
          content: req?.title || String(event.data.requirementId),
          timestamp: event.ts,
          requirementId: String(event.data.requirementId),
          requirementStatus: "failed",
        });
      } else if (
        event.type.endsWith("_started") &&
        !event.type.startsWith("tool_") &&
        !event.type.startsWith("requirement_")
      ) {
        const phase = event.type.replace("_started", "");
        entries.push({
          type: "phase",
          content: `Started ${phase}`,
          timestamp: event.ts,
          phase,
        });
      } else if (
        event.type.endsWith("_completed") &&
        !event.type.startsWith("tool_") &&
        !event.type.startsWith("requirement_")
      ) {
        const phase = event.type.replace("_completed", "");
        entries.push({
          type: "phase",
          content: `Completed ${phase}`,
          timestamp: event.ts,
          phase,
        });
      } else if (event.type === "tool_started") {
        // Detect AskUserQuestion tool calls for immediate question display
        const data = event.data as unknown as ToolEventData;
        if (data.toolName === "AskUserQuestion") {
          const args = data.args as { questions?: AskUserQuestion[] };
          if (args?.questions?.length) {
            entries.push({
              type: "message",
              role: "assistant",
              content: "",
              timestamp: event.ts,
              userQuestions: args.questions,
            });
          }
        }
      }
    }

    return entries;
  }, [events, requirements]);

  // Ensure QuestionCard renders immediately when questions arrive
  useEffect(() => {
    const lastQuestionEvent = events
      .slice()
      .reverse()
      .find((e) => {
        // Check agent_message with questions
        if (e.type === "agent_message" && "content" in e.data && !e.data.streaming) {
          return (e.data as { userQuestions?: AskUserQuestion[] }).userQuestions?.length;
        }
        // Check tool_started for AskUserQuestion (for immediate display)
        if (e.type === "tool_started") {
          const data = e.data as unknown as ToolEventData;
          if (data.toolName === "AskUserQuestion") {
            return (data.args as { questions?: AskUserQuestion[] })?.questions?.length;
          }
        }
        return false;
      });

    if (lastQuestionEvent && lastQuestionEvent.ts !== lastQuestionTsRef.current) {
      lastQuestionTsRef.current = lastQuestionEvent.ts;
      forceRender({});
    }
  }, [events]);

  // Apply text search filter
  const filteredEntries = useMemo(() => {
    if (!search.trim()) return logEntries;
    const searchLower = search.toLowerCase();
    return logEntries.filter((entry) => entry.content.toLowerCase().includes(searchLower));
  }, [logEntries, search]);

  // Auto-scroll to bottom when new entries arrive (not when filtering)
  useEffect(() => {
    if (!search.trim()) {
      scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logEntries.length, search]);

  // Find the last message for showing QuestionCard
  const lastMessageIndex = filteredEntries.length - 1;
  const lastEntry = filteredEntries[lastMessageIndex];
  const hasUnansweredQuestions =
    lastEntry?.type === "message" &&
    lastEntry?.role === "assistant" &&
    lastEntry?.userQuestions &&
    lastEntry.userQuestions.length > 0 &&
    !answeredQuestions.has(lastEntry.timestamp);

  // Check if there's a subsequent user message (meaning question was answered via text)
  const hasSubsequentUserMessage = logEntries
    .slice(logEntries.indexOf(lastEntry) + 1)
    .some((e) => e.type === "message" && e.role === "user");

  const showQuestionCard =
    hasUnansweredQuestions && !hasSubsequentUserMessage && onQuestionSubmit;

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="py-2 px-3 border-b space-y-2">
        <CardTitle className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Responses
        </CardTitle>
        <Input
          type="text"
          placeholder="Search responses..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto py-3 px-3">
        {filteredEntries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {search.trim() ? "No matching responses" : "Waiting for responses..."}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredEntries.map((entry, i) => (
              <LogEntryItem key={`${entry.timestamp}-${i}`} entry={entry} />
            ))}
            {showQuestionCard && lastEntry.userQuestions && (
              <QuestionCard
                key={lastEntry.timestamp}
                questions={lastEntry.userQuestions}
                onSubmit={(answers) => onQuestionSubmit!(answers, lastEntry.timestamp)}
                onSkipAll={() => onQuestionSubmit!({}, lastEntry.timestamp)}
                disabled={isSending}
              />
            )}
            <div ref={scrollRef} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LogEntryItem({ entry }: { entry: LogEntry }) {
  if (entry.type === "message") {
    return <MessageBubble entry={entry} />;
  }

  if (entry.type === "status") {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 py-1">
        <span className="text-gray-300">&#9679;</span>
        <span>{entry.content}</span>
        <span className="text-gray-300">{formatTime(entry.timestamp)}</span>
      </div>
    );
  }

  if (entry.type === "requirement") {
    const statusIcon =
      entry.requirementStatus === "completed"
        ? "✓"
        : entry.requirementStatus === "failed"
          ? "✕"
          : "▶";
    const statusColor =
      entry.requirementStatus === "completed"
        ? "text-green-600 bg-green-50"
        : entry.requirementStatus === "failed"
          ? "text-red-600 bg-red-50"
          : "text-blue-600 bg-blue-50";

    return (
      <div className={cn("flex items-center gap-2 text-xs py-1 px-2 rounded", statusColor)}>
        <span>{statusIcon}</span>
        <span className="font-medium">
          {entry.requirementStatus === "started" ? "Starting: " : ""}
          {entry.content}
        </span>
        <span className="text-gray-400 ml-auto">{formatTime(entry.timestamp)}</span>
      </div>
    );
  }

  if (entry.type === "phase") {
    const isCompleted = entry.content.startsWith("Completed");
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-xs py-1.5 px-3 rounded-full w-fit",
          isCompleted ? "bg-green-100 text-green-700" : "bg-purple-100 text-purple-700"
        )}
      >
        <span>{isCompleted ? "✓" : "▶"}</span>
        <span className="font-medium capitalize">{entry.content}</span>
      </div>
    );
  }

  return null;
}

function MessageBubble({ entry }: { entry: LogEntry }) {
  const isUser = entry.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2",
          isUser ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-900"
        )}
      >
        <div className="text-sm whitespace-pre-wrap">{entry.content}</div>
        <div className={cn("text-xs mt-1", isUser ? "text-blue-200" : "text-gray-400")}>
          {formatTime(entry.timestamp)}
        </div>
      </div>
    </div>
  );
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}
