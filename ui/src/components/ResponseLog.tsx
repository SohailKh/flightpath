import { useRef, useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import type {
  PipelineEvent,
  AskUserQuestion,
  Requirement,
  ToolEventData,
  ThinkingEventData,
  ToolUseBlockData,
  ContentBlockData,
  ErrorDetailData,
  ServerEventData,
  TestEventData,
  ScreenshotEventData,
  PipelineCompletedData,
  PipelineFailedData,
  TargetProjectData,
  TokenUsageData,
  TodoItem,
  ModelSelectionData,
} from "../types";
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

type LogEntryType =
  | "message"
  | "status"
  | "requirement"
  | "phase"
  | "tool"
  | "test"
  | "server"
  | "control"
  | "thinking"
  | "token"
  | "explorer"
  | "error"
  | "todo"
  | "terminal"
  | "project";

interface LogEntry {
  type: LogEntryType;
  subtype?: string;
  role?: "user" | "assistant";
  content: string;
  timestamp: string;
  userQuestions?: AskUserQuestion[];
  requirementId?: string;
  requirementStatus?: string;
  phase?: string;
  // Tool fields
  toolName?: string;
  toolUseId?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  toolDuration?: number;
  toolOutcome?: "success" | "warning" | "error";
  toolTokens?: { input: number; output: number };
  // Test fields
  testName?: string;
  testError?: string;
  // Server fields
  serverPlatform?: string;
  serverError?: string;
  // Token fields
  inputTokens?: number;
  outputTokens?: number;
  totalTurns?: number;
  // Explorer fields
  explorerType?: string;
  selectedModel?: string;
  complexityScore?: number;
  // Terminal fields
  completedCount?: number;
  failedCount?: number;
  totalCount?: number;
  pipelineError?: string;
  // Project fields
  projectName?: string;
  targetPath?: string;
  // Todo fields
  todos?: TodoItem[];
  // Screenshot fields
  screenshotPath?: string;
  screenshotName?: string;
  // Thinking turn
  turnNumber?: number;
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
      // User messages
      if (event.type === "user_message" && "content" in event.data) {
        entries.push({
          type: "message",
          role: "user",
          content: String(event.data.content),
          timestamp: event.ts,
        });
      }
      // Agent messages (QA phase)
      else if (
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
      }
      // Agent response (harness phase)
      else if (event.type === "agent_response" && "content" in event.data) {
        entries.push({
          type: "message",
          role: "assistant",
          content: String(event.data.content),
          timestamp: event.ts,
          turnNumber: (event.data as { turnNumber?: number }).turnNumber,
        });
      }
      // Status updates
      else if (event.type === "status_update") {
        const action = (event.data as { action?: string; message?: string }).action ||
          (event.data as { message?: string }).message;
        if (action) {
          entries.push({
            type: "status",
            content: String(action),
            timestamp: event.ts,
          });
        }
      }
      // Requirement events
      else if (event.type === "requirement_started" && "requirementId" in event.data) {
        const req = requirements.find((r) => r.id === event.data.requirementId);
        entries.push({
          type: "requirement",
          content: req?.title || String(event.data.requirementId),
          timestamp: event.ts,
          requirementId: String(event.data.requirementId),
          requirementStatus: "started",
        });
      }
      else if (event.type === "requirement_completed" && "requirementId" in event.data) {
        const req = requirements.find((r) => r.id === event.data.requirementId);
        entries.push({
          type: "requirement",
          content: req?.title || String(event.data.requirementId),
          timestamp: event.ts,
          requirementId: String(event.data.requirementId),
          requirementStatus: "completed",
        });
      }
      else if (event.type === "requirement_failed" && "requirementId" in event.data) {
        const req = requirements.find((r) => r.id === event.data.requirementId);
        entries.push({
          type: "requirement",
          content: req?.title || String(event.data.requirementId),
          timestamp: event.ts,
          requirementId: String(event.data.requirementId),
          requirementStatus: "failed",
        });
      }
      // Tool events
      else if (event.type === "tool_started") {
        const data = event.data as unknown as ToolEventData;
        // Special case: AskUserQuestion for immediate question display
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
        entries.push({
          type: "tool",
          subtype: "started",
          content: `${data.toolName}`,
          timestamp: event.ts,
          toolName: data.toolName,
          toolUseId: data.toolUseId,
          toolArgs: data.args,
        });
      }
      else if (event.type === "tool_completed") {
        const data = event.data as unknown as ToolEventData;
        entries.push({
          type: "tool",
          subtype: "completed",
          content: `${data.toolName}`,
          timestamp: event.ts,
          toolName: data.toolName,
          toolUseId: data.toolUseId,
          toolResult: data.result,
          toolDuration: data.durationMs,
          toolOutcome: data.outcome,
          toolTokens: data.inputTokens !== undefined ? {
            input: data.inputTokens,
            output: data.outputTokens ?? 0,
          } : undefined,
        });
      }
      else if (event.type === "tool_error") {
        const data = event.data as unknown as ToolEventData;
        entries.push({
          type: "tool",
          subtype: "error",
          content: `${data.toolName}: ${data.error}`,
          timestamp: event.ts,
          toolName: data.toolName,
          toolUseId: data.toolUseId,
          toolOutcome: "error",
        });
      }
      // Test events
      else if (event.type === "test_passed") {
        const data = event.data as TestEventData;
        entries.push({
          type: "test",
          subtype: "passed",
          content: data.testName || "Test passed",
          timestamp: event.ts,
          testName: data.testName,
        });
      }
      else if (event.type === "test_failed") {
        const data = event.data as TestEventData;
        entries.push({
          type: "test",
          subtype: "failed",
          content: data.testName || "Test failed",
          timestamp: event.ts,
          testName: data.testName,
          testError: data.error,
        });
      }
      else if (event.type === "screenshot_captured") {
        const data = event.data as ScreenshotEventData;
        entries.push({
          type: "test",
          subtype: "screenshot",
          content: data.name || "Screenshot captured",
          timestamp: event.ts,
          screenshotPath: data.path,
          screenshotName: data.name,
        });
      }
      // Server events
      else if (event.type === "server_starting") {
        entries.push({
          type: "server",
          subtype: "starting",
          content: "Server starting...",
          timestamp: event.ts,
        });
      }
      else if (event.type === "server_healthy") {
        const data = event.data as ServerEventData;
        entries.push({
          type: "server",
          subtype: "healthy",
          content: `Server healthy${data.platform ? ` (${data.platform})` : ""}`,
          timestamp: event.ts,
          serverPlatform: data.platform,
        });
      }
      else if (event.type === "server_error") {
        const data = event.data as ServerEventData;
        entries.push({
          type: "server",
          subtype: "error",
          content: data.error || "Server error",
          timestamp: event.ts,
          serverError: data.error,
          serverPlatform: data.platform,
        });
      }
      else if (event.type === "server_warning") {
        const data = event.data as ServerEventData;
        entries.push({
          type: "server",
          subtype: "warning",
          content: data.message || "Server warning",
          timestamp: event.ts,
        });
      }
      else if (event.type === "servers_ready") {
        entries.push({
          type: "server",
          subtype: "ready",
          content: "All servers ready",
          timestamp: event.ts,
        });
      }
      else if (event.type === "servers_stopped") {
        entries.push({
          type: "server",
          subtype: "stopped",
          content: "Servers stopped",
          timestamp: event.ts,
        });
      }
      // Control events
      else if (event.type === "paused") {
        entries.push({
          type: "control",
          subtype: "paused",
          content: "Pipeline paused",
          timestamp: event.ts,
        });
      }
      else if (event.type === "resumed") {
        entries.push({
          type: "control",
          subtype: "resumed",
          content: "Pipeline resumed",
          timestamp: event.ts,
        });
      }
      else if (event.type === "retry_started") {
        entries.push({
          type: "control",
          subtype: "retry",
          content: "Retrying...",
          timestamp: event.ts,
        });
      }
      else if (event.type === "aborted") {
        entries.push({
          type: "control",
          subtype: "aborted",
          content: "Pipeline aborted",
          timestamp: event.ts,
        });
      }
      // Terminal events
      else if (event.type === "pipeline_completed") {
        const data = event.data as PipelineCompletedData;
        entries.push({
          type: "terminal",
          subtype: "completed",
          content: `Pipeline completed: ${data.completed}/${data.totalRequirements} requirements`,
          timestamp: event.ts,
          completedCount: data.completed,
          failedCount: data.failed,
          totalCount: data.totalRequirements,
        });
      }
      else if (event.type === "pipeline_failed") {
        const data = event.data as PipelineFailedData;
        entries.push({
          type: "terminal",
          subtype: "failed",
          content: `Pipeline failed: ${data.error}`,
          timestamp: event.ts,
          pipelineError: data.error,
          phase: data.phase,
        });
      }
      // Token usage
      else if (event.type === "token_usage") {
        const data = event.data as TokenUsageData;
        const costLabel =
          data.totalCostUsd !== undefined ? ` • $${data.totalCostUsd.toFixed(4)}` : "";
        entries.push({
          type: "token",
          content: `Tokens: ${data.inputTokens.toLocaleString()} in / ${data.outputTokens.toLocaleString()} out${costLabel}`,
          timestamp: event.ts,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          totalTurns: data.totalTurns,
        });
      }
      // Todo updates
      else if (event.type === "todo_update") {
        const data = event.data as { todos: TodoItem[]; phase: string };
        entries.push({
          type: "todo",
          content: `${data.todos.length} todos`,
          timestamp: event.ts,
          todos: data.todos,
          phase: data.phase,
        });
      }
      // Explorer events
      else if (event.type === "parallel_exploration_started") {
        entries.push({
          type: "explorer",
          subtype: "parallel_started",
          content: "Starting parallel exploration",
          timestamp: event.ts,
        });
      }
      else if (event.type === "parallel_exploration_completed") {
        entries.push({
          type: "explorer",
          subtype: "parallel_completed",
          content: "Parallel exploration completed",
          timestamp: event.ts,
        });
      }
      else if (event.type === "explorer_started") {
        const data = event.data as { type: string; requirementId: string };
        entries.push({
          type: "explorer",
          subtype: "started",
          content: `Explorer ${data.type} started`,
          timestamp: event.ts,
          explorerType: data.type,
          requirementId: data.requirementId,
        });
      }
      else if (event.type === "explorer_completed") {
        const data = event.data as { type?: string };
        entries.push({
          type: "explorer",
          subtype: "completed",
          content: `Explorer ${data.type || ""} completed`,
          timestamp: event.ts,
          explorerType: data.type,
        });
      }
      else if (event.type === "explorer_error") {
        const data = event.data as { type: string; error: string };
        entries.push({
          type: "explorer",
          subtype: "error",
          content: `Explorer ${data.type} error: ${data.error}`,
          timestamp: event.ts,
          explorerType: data.type,
        });
      }
      else if (event.type === "model_selected") {
        const data = event.data as ModelSelectionData;
        entries.push({
          type: "explorer",
          subtype: "model_selected",
          content: `Model: ${data.selectedModel} (complexity: ${data.complexityScore})`,
          timestamp: event.ts,
          selectedModel: data.selectedModel,
          complexityScore: data.complexityScore,
          requirementId: data.requirementId,
        });
      }
      // SDK content blocks
      else if (event.type === "assistant_thinking") {
        const data = event.data as ThinkingEventData;
        entries.push({
          type: "thinking",
          content: data.content,
          timestamp: event.ts,
          turnNumber: data.turnNumber,
        });
      }
      else if (event.type === "assistant_tool_use") {
        const data = event.data as ToolUseBlockData;
        entries.push({
          type: "tool",
          subtype: "planning",
          content: `Planning: ${data.toolName}`,
          timestamp: event.ts,
          toolName: data.toolName,
          toolUseId: data.toolUseId,
          toolArgs: data.input,
          turnNumber: data.turnNumber,
        });
      }
      else if (event.type === "assistant_content_block") {
        const data = event.data as ContentBlockData;
        entries.push({
          type: "status",
          content: `Content block: ${data.blockType}`,
          timestamp: event.ts,
        });
      }
      else if (event.type === "agent_error_detail") {
        const data = event.data as ErrorDetailData;
        entries.push({
          type: "error",
          subtype: data.subtype,
          content: data.error,
          timestamp: event.ts,
          totalTurns: data.totalTurns,
        });
      }
      else if (event.type === "stream_chunk") {
        // Skip stream chunks to avoid noise - they're for real-time display
      }
      // Project setup
      else if (event.type === "target_project_set") {
        const data = event.data as TargetProjectData;
        entries.push({
          type: "project",
          content: `Project: ${data.projectName}`,
          timestamp: event.ts,
          projectName: data.projectName,
          targetPath: data.targetPath,
        });
      }
      // Requirements ready
      else if (event.type === "requirements_ready") {
        entries.push({
          type: "status",
          content: "Requirements ready",
          timestamp: event.ts,
        });
      }
      // Agent prompt (for debugging)
      else if (event.type === "agent_prompt") {
        // Skip agent prompts in the log - too verbose
      }
      // Phase transitions (catch-all for _started/_completed)
      else if (
        event.type.endsWith("_started") &&
        !event.type.startsWith("tool_") &&
        !event.type.startsWith("requirement_") &&
        !event.type.startsWith("explorer_") &&
        !event.type.startsWith("parallel_") &&
        !event.type.startsWith("server_")
      ) {
        const phase = event.type.replace("_started", "");
        entries.push({
          type: "phase",
          content: `Started ${phase}`,
          timestamp: event.ts,
          phase,
        });
      }
      else if (
        event.type.endsWith("_completed") &&
        !event.type.startsWith("tool_") &&
        !event.type.startsWith("requirement_") &&
        !event.type.startsWith("explorer_") &&
        !event.type.startsWith("parallel_") &&
        !event.type.startsWith("pipeline_")
      ) {
        const phase = event.type.replace("_completed", "");
        entries.push({
          type: "phase",
          content: `Completed ${phase}`,
          timestamp: event.ts,
          phase,
        });
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
        if (e.type === "agent_message" && "content" in e.data && !e.data.streaming) {
          return (e.data as { userQuestions?: AskUserQuestion[] }).userQuestions?.length;
        }
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

  // Auto-scroll to bottom when new entries arrive
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
    return <RequirementEntry entry={entry} />;
  }

  if (entry.type === "phase") {
    return <PhaseEntry entry={entry} />;
  }

  if (entry.type === "tool") {
    return <ToolEntry entry={entry} />;
  }

  if (entry.type === "test") {
    return <TestEntry entry={entry} />;
  }

  if (entry.type === "server") {
    return <ServerEntry entry={entry} />;
  }

  if (entry.type === "control") {
    return <ControlEntry entry={entry} />;
  }

  if (entry.type === "thinking") {
    return <ThinkingEntry entry={entry} />;
  }

  if (entry.type === "token") {
    return <TokenEntry entry={entry} />;
  }

  if (entry.type === "explorer") {
    return <ExplorerEntry entry={entry} />;
  }

  if (entry.type === "error") {
    return <ErrorEntry entry={entry} />;
  }

  if (entry.type === "todo") {
    return <TodoEntry entry={entry} />;
  }

  if (entry.type === "terminal") {
    return <TerminalEntry entry={entry} />;
  }

  if (entry.type === "project") {
    return <ProjectEntry entry={entry} />;
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
          {entry.turnNumber !== undefined && ` (turn ${entry.turnNumber})`}
        </div>
      </div>
    </div>
  );
}

function RequirementEntry({ entry }: { entry: LogEntry }) {
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

function PhaseEntry({ entry }: { entry: LogEntry }) {
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

function ToolEntry({ entry }: { entry: LogEntry }) {
  const isError = entry.subtype === "error";
  const isPlanning = entry.subtype === "planning";
  const isCompleted = entry.subtype === "completed";

  // Skip TodoWrite tool entries entirely - they're shown via TodoEntry from todo_update events
  if (entry.toolName === "TodoWrite") {
    return null;
  }

  const bgColor = isError
    ? "bg-red-50 border-red-200"
    : isPlanning
      ? "bg-yellow-50 border-yellow-200"
      : isCompleted
        ? "bg-gray-50 border-gray-200"
        : "bg-blue-50 border-blue-200";

  const textColor = isError
    ? "text-red-700"
    : isPlanning
      ? "text-yellow-700"
      : "text-gray-700";

  return (
    <div className={cn("text-xs border rounded p-2 space-y-1", bgColor)}>
      <div className={cn("flex items-center gap-2", textColor)}>
        <span className="font-mono font-medium">{entry.toolName}</span>
        {entry.toolDuration !== undefined && (
          <span className="text-gray-400">{entry.toolDuration}ms</span>
        )}
        {entry.toolOutcome && (
          <span
            className={cn(
              "px-1.5 py-0.5 rounded text-[10px] uppercase",
              entry.toolOutcome === "success"
                ? "bg-green-100 text-green-700"
                : entry.toolOutcome === "warning"
                  ? "bg-yellow-100 text-yellow-700"
                  : "bg-red-100 text-red-700"
            )}
          >
            {entry.toolOutcome}
          </span>
        )}
        {entry.toolTokens && (
          <span className="text-gray-400 ml-auto">
            {entry.toolTokens.input}↓ {entry.toolTokens.output}↑
          </span>
        )}
        <span className="text-gray-300 ml-auto">{formatTime(entry.timestamp)}</span>
      </div>
      {entry.toolArgs && (
        <div className="text-gray-600">
          <div className="text-[10px] uppercase text-gray-400 mb-0.5">Args</div>
          <pre className="text-[11px] bg-white/50 p-1 rounded overflow-x-auto max-h-32 overflow-y-auto">
            {JSON.stringify(entry.toolArgs, null, 2)}
          </pre>
        </div>
      )}
      {entry.toolResult && (
        <div className="text-gray-600">
          <div className="text-[10px] uppercase text-gray-400 mb-0.5">Result</div>
          <pre className="text-[11px] bg-white/50 p-1 rounded overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
            {typeof entry.toolResult === "string"
              ? entry.toolResult
              : JSON.stringify(entry.toolResult, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function TestEntry({ entry }: { entry: LogEntry }) {
  const isPassed = entry.subtype === "passed";
  const isScreenshot = entry.subtype === "screenshot";

  if (isScreenshot) {
    return (
      <div className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-indigo-50 text-indigo-700">
        <span>📷</span>
        <span>{entry.content}</span>
        {entry.screenshotPath && (
          <span className="text-indigo-400 font-mono text-[10px] truncate max-w-[200px]">
            {entry.screenshotPath}
          </span>
        )}
        <span className="text-gray-400 ml-auto">{formatTime(entry.timestamp)}</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs py-1 px-2 rounded",
        isPassed ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
      )}
    >
      <span>{isPassed ? "✓" : "✕"}</span>
      <span className="font-medium">{entry.content}</span>
      {entry.testError && (
        <span className="text-red-500 truncate max-w-[300px]">{entry.testError}</span>
      )}
      <span className="text-gray-400 ml-auto">{formatTime(entry.timestamp)}</span>
    </div>
  );
}

function ServerEntry({ entry }: { entry: LogEntry }) {
  const colorMap: Record<string, string> = {
    starting: "bg-yellow-50 text-yellow-700",
    healthy: "bg-green-50 text-green-700",
    ready: "bg-green-50 text-green-700",
    error: "bg-red-50 text-red-700",
    warning: "bg-orange-50 text-orange-700",
    stopped: "bg-gray-50 text-gray-500",
  };

  const iconMap: Record<string, string> = {
    starting: "⏳",
    healthy: "✓",
    ready: "✓",
    error: "✕",
    warning: "⚠",
    stopped: "■",
  };

  const color = colorMap[entry.subtype || ""] || "bg-gray-50 text-gray-700";
  const icon = iconMap[entry.subtype || ""] || "●";

  return (
    <div className={cn("flex items-center gap-2 text-xs py-1 px-2 rounded", color)}>
      <span>{icon}</span>
      <span>{entry.content}</span>
      {entry.serverError && <span className="text-red-500 truncate">{entry.serverError}</span>}
      <span className="text-gray-400 ml-auto">{formatTime(entry.timestamp)}</span>
    </div>
  );
}

function ControlEntry({ entry }: { entry: LogEntry }) {
  const colorMap: Record<string, string> = {
    paused: "bg-yellow-100 text-yellow-700",
    resumed: "bg-green-100 text-green-700",
    retry: "bg-blue-100 text-blue-700",
    aborted: "bg-red-100 text-red-700",
  };

  const iconMap: Record<string, string> = {
    paused: "⏸",
    resumed: "▶",
    retry: "↻",
    aborted: "⏹",
  };

  const color = colorMap[entry.subtype || ""] || "bg-gray-100 text-gray-700";
  const icon = iconMap[entry.subtype || ""] || "●";

  return (
    <div
      className={cn("flex items-center gap-2 text-xs py-1.5 px-3 rounded-full w-fit", color)}
    >
      <span>{icon}</span>
      <span className="font-medium">{entry.content}</span>
    </div>
  );
}

function ThinkingEntry({ entry }: { entry: LogEntry }) {
  return (
    <div className="text-xs border border-purple-200 bg-purple-50 rounded p-2">
      <div className="flex items-center gap-2 text-purple-600 mb-1">
        <span>💭</span>
        <span className="font-medium">Thinking</span>
        {entry.turnNumber !== undefined && (
          <span className="text-purple-400">(turn {entry.turnNumber})</span>
        )}
        <span className="text-gray-300 ml-auto">{formatTime(entry.timestamp)}</span>
      </div>
      <div className="text-purple-800 whitespace-pre-wrap text-[11px] leading-relaxed">
        {entry.content}
      </div>
    </div>
  );
}

function TokenEntry({ entry }: { entry: LogEntry }) {
  return (
    <div className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-gray-100 text-gray-600">
      <span>📊</span>
      <span>
        <span className="font-medium">{entry.inputTokens?.toLocaleString()}</span> input
      </span>
      <span>·</span>
      <span>
        <span className="font-medium">{entry.outputTokens?.toLocaleString()}</span> output
      </span>
      {entry.totalTurns !== undefined && (
        <>
          <span>·</span>
          <span>{entry.totalTurns} turns</span>
        </>
      )}
      <span className="text-gray-300 ml-auto">{formatTime(entry.timestamp)}</span>
    </div>
  );
}

function ExplorerEntry({ entry }: { entry: LogEntry }) {
  const colorMap: Record<string, string> = {
    parallel_started: "bg-indigo-50 text-indigo-700",
    parallel_completed: "bg-indigo-100 text-indigo-700",
    started: "bg-blue-50 text-blue-700",
    completed: "bg-green-50 text-green-700",
    error: "bg-red-50 text-red-700",
    model_selected: "bg-purple-50 text-purple-700",
  };

  const color = colorMap[entry.subtype || ""] || "bg-gray-50 text-gray-700";

  return (
    <div className={cn("flex items-center gap-2 text-xs py-1 px-2 rounded", color)}>
      <span>🔍</span>
      <span>{entry.content}</span>
      {entry.explorerType && (
        <span className="px-1 py-0.5 bg-white/50 rounded text-[10px]">{entry.explorerType}</span>
      )}
      {entry.selectedModel && (
        <span className="font-mono text-[10px]">{entry.selectedModel}</span>
      )}
      <span className="text-gray-400 ml-auto">{formatTime(entry.timestamp)}</span>
    </div>
  );
}

function ErrorEntry({ entry }: { entry: LogEntry }) {
  return (
    <div className="text-xs border border-red-200 bg-red-50 rounded p-2">
      <div className="flex items-center gap-2 text-red-600 mb-1">
        <span>⚠</span>
        <span className="font-medium">Error</span>
        {entry.subtype && <span className="text-red-400">({entry.subtype})</span>}
        <span className="text-gray-300 ml-auto">{formatTime(entry.timestamp)}</span>
      </div>
      <div className="text-red-700 whitespace-pre-wrap">{entry.content}</div>
      {entry.totalTurns !== undefined && (
        <div className="text-red-400 mt-1">After {entry.totalTurns} turns</div>
      )}
    </div>
  );
}

function TodoEntry({ entry }: { entry: LogEntry }) {
  if (!entry.todos || entry.todos.length === 0) return null;

  return (
    <div className="text-xs border border-gray-200 bg-gray-50 rounded p-2">
      <div className="flex items-center gap-2 text-gray-600 mb-1">
        <span>📋</span>
        <span className="font-medium">Todos</span>
        {entry.phase && <span className="text-gray-400">({entry.phase})</span>}
        <span className="text-gray-300 ml-auto">{formatTime(entry.timestamp)}</span>
      </div>
      <div className="space-y-0.5">
        {entry.todos.map((todo, i) => (
          <div key={i} className="flex items-center gap-2">
            <span
              className={cn(
                "w-4 h-4 flex items-center justify-center rounded text-[10px]",
                todo.status === "completed"
                  ? "bg-green-100 text-green-600"
                  : todo.status === "in_progress"
                    ? "bg-blue-100 text-blue-600"
                    : "bg-gray-100 text-gray-400"
              )}
            >
              {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : "○"}
            </span>
            <span className={todo.status === "completed" ? "line-through text-gray-400" : ""}>
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TerminalEntry({ entry }: { entry: LogEntry }) {
  const isCompleted = entry.subtype === "completed";

  return (
    <div
      className={cn(
        "text-xs border rounded p-3",
        isCompleted ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 font-medium",
          isCompleted ? "text-green-700" : "text-red-700"
        )}
      >
        <span>{isCompleted ? "✓" : "✕"}</span>
        <span>{isCompleted ? "Pipeline Completed" : "Pipeline Failed"}</span>
      </div>
      {isCompleted && entry.totalCount !== undefined && (
        <div className="mt-2 text-green-600">
          <span className="font-medium">{entry.completedCount}</span> / {entry.totalCount}{" "}
          requirements completed
          {entry.failedCount !== undefined && entry.failedCount > 0 && (
            <span className="text-red-500 ml-2">({entry.failedCount} failed)</span>
          )}
        </div>
      )}
      {!isCompleted && entry.pipelineError && (
        <div className="mt-2 text-red-600">{entry.pipelineError}</div>
      )}
      {entry.phase && <div className="mt-1 text-gray-500">Phase: {entry.phase}</div>}
    </div>
  );
}

function ProjectEntry({ entry }: { entry: LogEntry }) {
  return (
    <div className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-blue-50 text-blue-700">
      <span>📁</span>
      <span className="font-medium">{entry.projectName}</span>
      {entry.targetPath && (
        <span className="text-blue-400 font-mono text-[10px] truncate max-w-[300px]">
          {entry.targetPath}
        </span>
      )}
      <span className="text-gray-300 ml-auto">{formatTime(entry.timestamp)}</span>
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
