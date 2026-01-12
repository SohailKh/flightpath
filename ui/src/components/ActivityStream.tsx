import { useRef, useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { PipelineEvent, PipelinePhase, ToolEventData, StatusUpdateData, TodoEventData, TodoItem, AgentResponseData, TokenUsageData } from "../types";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

interface ActivityStreamProps {
  events: PipelineEvent[];
  maxItems?: number;
  currentPhase?: PipelinePhase;
}

const phaseLabels: Record<PipelinePhase, string> = {
  qa: "Q&A",
  exploring: "Exploring",
  planning: "Planning",
  executing: "Executing",
  testing: "Testing",
};

const phaseColors: Record<PipelinePhase, string> = {
  qa: "bg-yellow-500",
  exploring: "bg-cyan-500",
  planning: "bg-purple-500",
  executing: "bg-green-500",
  testing: "bg-blue-500",
};

function getDefaultAction(phase: PipelinePhase): string {
  switch (phase) {
    case "qa":
      return "Processing your response...";
    case "exploring":
      return "Exploring codebase patterns...";
    case "planning":
      return "Analyzing requirements...";
    case "executing":
      return "Implementing features...";
    case "testing":
      return "Verifying implementation...";
  }
}

export function ActivityStream({ events, maxItems = 100, currentPhase }: ActivityStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Get the current status action
  const currentAction = useMemo(() => {
    if (!currentPhase) return null;

    const statusEvents = events.filter((e) => e.type === "status_update");
    const lastStatus = statusEvents[statusEvents.length - 1];
    const completedEvents = events.filter((e) => e.type === "tool_completed");
    const lastCompleted = completedEvents[completedEvents.length - 1];

    // If a tool_completed event occurred after the last status_update,
    // the tool finished - show the default action (e.g. "Analyzing requirements...")
    // which describes what the agent is doing while thinking
    if (lastCompleted && lastStatus) {
      const statusIndex = events.indexOf(lastStatus);
      const completedIndex = events.indexOf(lastCompleted);
      if (completedIndex > statusIndex) {
        return getDefaultAction(currentPhase);
      }
    }

    if (!lastStatus) {
      return getDefaultAction(currentPhase);
    }

    const data = lastStatus.data as unknown as StatusUpdateData;
    return data.action || getDefaultAction(currentPhase);
  }, [events, currentPhase]);

  // Reset timer whenever events change
  useEffect(() => {
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [events.length]);

  // Filter to activity events
  const activityEvents = useMemo(() => {
    return events
      .filter(
        (e) =>
          e.type === "tool_started" ||
          e.type === "tool_completed" ||
          e.type === "tool_error" ||
          e.type === "status_update" ||
          e.type === "todo_update" ||
          e.type === "agent_response" ||
          e.type === "token_usage" ||
          e.type.endsWith("_started") ||
          e.type.endsWith("_completed")
      )
      .slice(-maxItems);
  }, [events, maxItems]);

  // Deduplicate consecutive identical status_update events
  const deduplicatedEvents = useMemo(() => {
    const result: typeof activityEvents = [];
    for (const event of activityEvents) {
      const lastEvent = result[result.length - 1];
      // Skip consecutive duplicate status_update events
      if (
        event.type === "status_update" &&
        lastEvent?.type === "status_update" &&
        "action" in event.data &&
        "action" in lastEvent.data &&
        (event.data as StatusUpdateData).action === (lastEvent.data as StatusUpdateData).action
      ) {
        // Replace with the newer event (keeps most recent timestamp)
        result[result.length - 1] = event;
        continue;
      }
      result.push(event);
    }
    return result;
  }, [activityEvents]);

  // Apply text search filter
  const filteredEvents = useMemo(() => {
    if (!search.trim()) return deduplicatedEvents;
    const searchLower = search.toLowerCase();
    return deduplicatedEvents.filter((event) => {
      const data = event.data as unknown as ToolEventData;
      const statusData = event.data as unknown as StatusUpdateData;
      const agentData = event.data as unknown as AgentResponseData;
      const searchableText = [
        event.type,
        data.toolName,
        data.error,
        (data.args as Record<string, unknown>)?.file_path,
        (data.args as Record<string, unknown>)?.path,
        (data.args as Record<string, unknown>)?.command,
        statusData.action,
        agentData.content,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(searchLower);
    });
  }, [deduplicatedEvents, search]);

  // Auto-scroll to bottom when new events arrive (not when filtering)
  useEffect(() => {
    if (!search.trim()) {
      scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activityEvents.length, search]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="py-2 px-3 border-b space-y-2">
        <CardTitle className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Activity Stream
        </CardTitle>
        <Input
          type="text"
          placeholder="Search activities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto p-0 min-h-0">
        {filteredEvents.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {search.trim() ? "No matching activities" : "Waiting for activity..."}
          </div>
        ) : (
          <div className="font-mono text-xs">
            {filteredEvents.map((event, i) => (
              <ActivityItem
                key={`${event.ts}-${i}`}
                event={event}
                nextTs={filteredEvents[i + 1]?.ts}
              />
            ))}
            <div ref={scrollRef} />
          </div>
        )}
      </CardContent>
      {/* Status bar - pinned at bottom */}
      {currentPhase && currentAction && (
        <div className="flex items-center gap-4 px-5 py-4 bg-gradient-to-r from-slate-800 to-slate-700 border-t border-slate-600 rounded-b-lg">
          <span
            className={cn(
              "w-4 h-4 rounded-full animate-pulse flex-shrink-0",
              phaseColors[currentPhase]
            )}
          />
          <span className="text-base font-semibold text-white">
            {phaseLabels[currentPhase]}:
          </span>
          <span className="text-base text-slate-200 flex-1 truncate">{currentAction}</span>
          <span className="text-base text-slate-300 font-mono font-medium flex-shrink-0">
            {formatTime(elapsedSeconds)}
          </span>
        </div>
      )}
    </Card>
  );
}

// Phase badge colors for inline display
const phaseBadgeColors: Record<PipelinePhase, string> = {
  qa: "bg-yellow-100 text-yellow-700",
  exploring: "bg-cyan-100 text-cyan-700",
  planning: "bg-purple-100 text-purple-700",
  executing: "bg-green-100 text-green-700",
  testing: "bg-blue-100 text-blue-700",
};

function ActivityItem({ event, nextTs }: { event: PipelineEvent; nextTs?: string }) {
  const data = event.data as unknown as ToolEventData;
  const time = new Date(event.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // Calculate duration to next event
  const durationToNext = nextTs
    ? Math.round((new Date(nextTs).getTime() - new Date(event.ts).getTime()) / 1000)
    : null;

  const formatDuration = (seconds: number) => {
    if (seconds >= 60) {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      return `+${mins}m ${secs}s`;
    }
    return `+${seconds}s`;
  };

  const formatToolDuration = (ms: number) => {
    if (ms >= 60000) {
      const mins = Math.floor(ms / 60000);
      const secs = Math.round((ms % 60000) / 1000);
      return `${mins}m ${secs}s`;
    }
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(1)}s`;
    }
    return `${ms}ms`;
  };

  const formatTokenCount = (tokens: number): string => {
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}K`;
    }
    return tokens.toString();
  };

  const getIcon = () => {
    if (event.type === "todo_update") return "\u2611"; // Ballot box with check
    if (event.type === "agent_response") return "\u{1F4AC}"; // Speech bubble
    if (event.type === "token_usage") return "\u{1F4CA}"; // Bar chart
    if (event.type === "tool_started") return ">";
    if (event.type === "tool_completed") {
      // Show warning icon if outcome indicates issues
      if (data.outcome === "warning") return "⚠";
      return "\u2713";
    }
    if (event.type === "tool_error") return "\u2717";
    if (event.type === "status_update") return "\u25CF";
    if (event.type.endsWith("_started")) return "\u25CB";
    if (event.type.endsWith("_completed")) return "\u2713";
    return "-";
  };

  const getColor = () => {
    if (event.type === "todo_update") return "text-indigo-600";
    if (event.type === "agent_response") return "text-purple-700 bg-purple-50";
    if (event.type === "token_usage") return "text-teal-600 bg-teal-50";
    if (event.type === "tool_error") return "text-red-600 bg-red-50";
    if (event.type === "tool_completed") {
      // Yellow/warning color if outcome has issues
      if (data.outcome === "warning") return "text-amber-600";
      return "text-green-700";
    }
    if (event.type === "tool_started") return "text-blue-600";
    if (event.type === "status_update") return "text-slate-500";
    if (event.type.endsWith("_completed")) return "text-green-600";
    return "text-gray-600";
  };

  // Get full path for tooltip
  const getFullPath = (): string | null => {
    if (event.type !== "tool_started" || !data.toolName) return null;
    const args = data.args as Record<string, unknown> | undefined;
    const path = args?.file_path || args?.path;
    return path ? String(path) : null;
  };

  const getMessage = () => {
    if (event.type === "agent_response") {
      const agentData = event.data as unknown as AgentResponseData;
      return `Turn ${agentData.turnNumber}: ${agentData.content}`;
    }
    if (event.type === "token_usage") {
      const tokenData = event.data as unknown as TokenUsageData;
      return `Tokens: ${tokenData.inputTokens.toLocaleString()} in / ${tokenData.outputTokens.toLocaleString()} out (${tokenData.totalTurns} turns)`;
    }
    if (event.type === "todo_update") {
      const todoData = event.data as unknown as TodoEventData;
      const inProgress = todoData.todos.filter((t: TodoItem) => t.status === "in_progress");
      const completed = todoData.todos.filter((t: TodoItem) => t.status === "completed");
      // Show the currently active todo's activeForm, or progress summary
      if (inProgress.length > 0) {
        return inProgress[0].activeForm;
      }
      return `Tasks: ${completed.length}/${todoData.todos.length} done`;
    }
    if (event.type === "tool_started" && data.toolName) {
      const args = data.args as Record<string, unknown> | undefined;
      const path = args?.file_path || args?.path || "";
      const cmd = args?.command;
      if (path) return `${data.toolName} ${truncatePath(String(path))}`;
      if (cmd) return `${data.toolName} ${truncateCmd(String(cmd))}`;
      return data.toolName;
    }
    if (event.type === "tool_completed" && data.toolName) {
      // Include duration in completed message
      const duration = data.durationMs ? ` (${formatToolDuration(data.durationMs)})` : "";
      // Include token usage if available
      const hasTokens = data.inputTokens !== undefined || data.outputTokens !== undefined;
      const tokenDisplay = hasTokens
        ? ` [${formatTokenCount(data.inputTokens ?? 0)} in / ${formatTokenCount(data.outputTokens ?? 0)} out]`
        : "";
      return `${data.toolName} done${duration}${tokenDisplay}`;
    }
    if (event.type === "tool_error" && data.toolName) {
      return `${data.toolName} failed: ${data.error}`;
    }
    if (event.type === "status_update") {
      const statusData = event.data as unknown as StatusUpdateData;
      return statusData.action || "Status update";
    }
    // Phase events
    return event.type.replace(/_/g, " ");
  };

  const fullPath = getFullPath();
  const phase = data.phase;

  // Agent responses and token usage get expanded display
  const isExpandedType = event.type === "agent_response" || event.type === "token_usage";

  return (
    <div
      className={cn(
        "flex items-start gap-2 px-3 border-b border-gray-100 hover:bg-gray-50",
        isExpandedType ? "py-2" : "py-1",
        getColor()
      )}
      title={fullPath || undefined}
    >
      <span className="text-gray-400 w-16 flex-shrink-0">{time}</span>
      {phase && (
        <span className={cn("text-[10px] px-1 rounded flex-shrink-0", phaseBadgeColors[phase])}>
          {phaseLabels[phase]}
        </span>
      )}
      <span className="w-4">{getIcon()}</span>
      <span className={cn("flex-1", isExpandedType ? "whitespace-pre-wrap break-words" : "truncate")}>
        {getMessage()}
      </span>
      {durationToNext !== null && (
        <span className="text-gray-400 text-right flex-shrink-0 w-16">
          {formatDuration(durationToNext)}
        </span>
      )}
    </div>
  );
}

function truncatePath(path: string): string {
  const parts = path.split("/");
  return parts.length > 3 ? ".../" + parts.slice(-2).join("/") : path;
}

function truncateCmd(cmd: string): string {
  return cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd;
}
