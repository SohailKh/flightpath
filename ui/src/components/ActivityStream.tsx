import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import type {
  PipelineEvent,
  PipelinePhase,
  ToolEventData,
  StatusUpdateData,
  AgentPromptData,
  TokenUsageData,
} from "../types";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

// ============================================================================
// Data Structures for Tree View
// ============================================================================

interface AgentGroup {
  id: string;
  agentName: string;
  label: string;
  toolCount: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd?: number;
  status: "running" | "done" | "error";
  events: ProcessedEvent[];
}

interface ProcessedEvent {
  id: string;
  type: "tool" | "status" | "phase";
  toolName?: string;
  primaryArg?: string;
  result?: string;
  durationMs?: number;
  outcome?: "success" | "warning" | "error";
}

type DisplayItem =
  | { kind: "agent-header"; group: AgentGroup }
  | { kind: "agent-child"; group: AgentGroup; event: ProcessedEvent; isLast: boolean }
  | { kind: "standalone-tool"; event: ProcessedEvent }
  | { kind: "status"; content: string; id: string };

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

function getInitialPrompt(event: PipelineEvent): string | null {
  if (event.type !== "qa_started") return null;
  const data = event.data as { initialPrompt?: unknown };
  if (typeof data.initialPrompt !== "string") return null;
  return data.initialPrompt.trim() ? data.initialPrompt : null;
}

// ============================================================================
// String Utilities
// ============================================================================

function truncatePath(path: string): string {
  const parts = path.split("/");
  return parts.length > 3 ? ".../" + parts.slice(-2).join("/") : path;
}

function truncateCmd(cmd: string): string {
  return cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd;
}

// ============================================================================
// Tool Result Formatting
// ============================================================================

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

function formatUsd(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  return `$${cost.toFixed(2)}`;
}

function formatToolResult(toolName: string, result: unknown, args?: Record<string, unknown>): string {
  if (!result) return "Done";

  const resultStr = typeof result === "string" ? result : JSON.stringify(result);

  if (toolName === "Read") {
    // Count lines from result
    const lines = resultStr.split("\n").length;
    return `Read ${lines} lines`;
  }
  if (toolName === "Grep") {
    // Count matches (files or content lines)
    const matches = resultStr.split("\n").filter(Boolean).length;
    return matches > 0 ? `Found ${matches} matches` : "No matches";
  }
  if (toolName === "Glob") {
    const files = resultStr.split("\n").filter(Boolean).length;
    return files > 0 ? `Found ${files} files` : "No files";
  }
  if (toolName === "Edit") return "Edit applied";
  if (toolName === "Write") return "File written";
  if (toolName === "Bash") {
    // Show first line of output or "Completed"
    const firstLine = resultStr.split("\n")[0]?.trim();
    if (firstLine && firstLine.length < 50) return firstLine;
    return "Completed";
  }
  if (toolName === "Task") {
    // Parse agent task result
    const match = resultStr.match(/(\d+)\s*tool\s*uses?/i);
    const toolUses = match ? match[1] : "?";
    return `${toolUses} tool uses`;
  }
  return "Done";
}

function extractPrimaryArg(toolName: string, args?: Record<string, unknown>): string {
  if (!args) return "";

  if (toolName === "Read" || toolName === "Write" || toolName === "Edit") {
    const path = args.file_path || args.path;
    return path ? truncatePath(String(path)) : "";
  }
  if (toolName === "Grep") {
    return args.pattern ? String(args.pattern) : "";
  }
  if (toolName === "Glob") {
    return args.pattern ? String(args.pattern) : "";
  }
  if (toolName === "Bash") {
    const desc = args.description;
    if (desc) return String(desc).slice(0, 40);
    const cmd = args.command;
    return cmd ? truncateCmd(String(cmd)) : "";
  }
  if (toolName === "Task") {
    return args.description ? String(args.description).slice(0, 50) : "";
  }
  return "";
}

function extractAgentLabel(promptData: AgentPromptData): string {
  // Try to extract a meaningful label from the prompt
  const prompt = promptData.prompt;
  if (!prompt) return promptData.agentName || "Agent";

  // Look for common patterns in agent prompts
  const firstLine = prompt.split("\n")[0]?.trim();
  if (firstLine && firstLine.length < 60) {
    return firstLine;
  }

  // Use requirement ID if available
  if (promptData.requirementId) {
    return `Task: ${promptData.requirementId}`;
  }

  return promptData.agentName || "Agent";
}

// ============================================================================
// Event Grouping Logic
// ============================================================================

function groupEvents(events: PipelineEvent[], collapsedGroups: Set<string>): DisplayItem[] {
  const items: DisplayItem[] = [];
  const groups: AgentGroup[] = [];
  let currentGroup: AgentGroup | null = null;

  // Map to pair tool_started with tool_completed
  const toolPairs = new Map<string, { started: PipelineEvent; completed?: PipelineEvent }>();

  for (const event of events) {
    const data = event.data as Record<string, unknown>;

    // Start a new agent group on agent_prompt
    if (event.type === "agent_prompt") {
      // Finalize previous group
      if (currentGroup) {
        groups.push(currentGroup);
      }

      const promptData = data as unknown as AgentPromptData;
      currentGroup = {
        id: event.ts,
        agentName: promptData.agentName || "unknown",
        label: extractAgentLabel(promptData),
        toolCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCostUsd: undefined,
        status: "running",
        events: [],
      };
      continue;
    }

    // Track tool_started events
    if (event.type === "tool_started") {
      const toolData = data as unknown as ToolEventData;
      if (toolData.toolUseId) {
        toolPairs.set(toolData.toolUseId, { started: event });
      }
      continue;
    }

    // Process tool_completed events (merge with started)
    if (event.type === "tool_completed") {
      const toolData = data as unknown as ToolEventData;
      const pair = toolData.toolUseId ? toolPairs.get(toolData.toolUseId) : undefined;
      const startedData = pair?.started.data as unknown as ToolEventData | undefined;

      const processed: ProcessedEvent = {
        id: event.ts,
        type: "tool",
        toolName: toolData.toolName,
        primaryArg: extractPrimaryArg(toolData.toolName || "", startedData?.args as Record<string, unknown>),
        result: formatToolResult(toolData.toolName || "", toolData.result, startedData?.args as Record<string, unknown>),
        durationMs: toolData.durationMs,
        outcome: toolData.outcome as "success" | "warning" | "error" | undefined,
      };

      if (currentGroup) {
        currentGroup.events.push(processed);
        currentGroup.toolCount++;
      } else {
        items.push({ kind: "standalone-tool", event: processed });
      }
      continue;
    }

    // Process tool_error events
    if (event.type === "tool_error") {
      const toolData = data as unknown as ToolEventData;

      const processed: ProcessedEvent = {
        id: event.ts,
        type: "tool",
        toolName: toolData.toolName,
        primaryArg: "",
        result: toolData.error ? `Error: ${toolData.error}` : "Error",
        outcome: "error",
      };

      if (currentGroup) {
        currentGroup.events.push(processed);
        currentGroup.status = "error";
      } else {
        items.push({ kind: "standalone-tool", event: processed });
      }
      continue;
    }

    // Token usage marks end of agent turn with stats
    if (event.type === "token_usage") {
      const tokenData = data as unknown as TokenUsageData;
      if (currentGroup) {
        currentGroup.inputTokens = tokenData.inputTokens || 0;
        currentGroup.outputTokens = tokenData.outputTokens || 0;
        currentGroup.totalCostUsd = tokenData.totalCostUsd;
        currentGroup.status = "done";
        groups.push(currentGroup);
        currentGroup = null;
      }
      continue;
    }

    // Status updates become standalone items if no current group
    if (event.type === "status_update") {
      const statusData = data as unknown as StatusUpdateData;
      if (statusData.action && !currentGroup) {
        items.push({ kind: "status", content: statusData.action, id: event.ts });
      }
      continue;
    }
  }

  // Finalize any remaining group
  if (currentGroup) {
    groups.push(currentGroup);
  }

  // Convert groups to display items
  const result: DisplayItem[] = [];

  for (const group of groups) {
    result.push({ kind: "agent-header", group });

    // Add children if not collapsed
    if (!collapsedGroups.has(group.id)) {
      group.events.forEach((event, index) => {
        result.push({
          kind: "agent-child",
          group,
          event,
          isLast: index === group.events.length - 1,
        });
      });
    }
  }

  // Add standalone items
  result.push(...items);

  return result;
}

export function ActivityStream({ events, maxItems = 100, currentPhase }: ActivityStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Toggle collapse state for a group
  const toggleCollapse = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // Get the current status action
  const currentAction = useMemo(() => {
    if (!currentPhase) return null;

    const statusEvents = events.filter((e) => e.type === "status_update");
    const lastStatus = statusEvents[statusEvents.length - 1];
    const completedEvents = events.filter((e) => e.type === "tool_completed");
    const lastCompleted = completedEvents[completedEvents.length - 1];

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
          e.type === "agent_prompt" ||
          e.type === "agent_response" ||
          e.type === "token_usage" ||
          e.type.endsWith("_started") ||
          e.type.endsWith("_completed")
      )
      .slice(-maxItems);
  }, [events, maxItems]);

  // Group events into tree structure
  const displayItems = useMemo(() => {
    return groupEvents(activityEvents, collapsedGroups);
  }, [activityEvents, collapsedGroups]);

  // Apply text search filter
  const filteredItems = useMemo(() => {
    if (!search.trim()) return displayItems;
    const searchLower = search.toLowerCase();
    return displayItems.filter((item) => {
      if (item.kind === "agent-header") {
        return item.group.label.toLowerCase().includes(searchLower) ||
               item.group.agentName.toLowerCase().includes(searchLower);
      }
      if (item.kind === "agent-child" || item.kind === "standalone-tool") {
        const event = item.event;
        return (
          (event.toolName?.toLowerCase().includes(searchLower) ?? false) ||
          (event.primaryArg?.toLowerCase().includes(searchLower) ?? false) ||
          (event.result?.toLowerCase().includes(searchLower) ?? false)
        );
      }
      if (item.kind === "status") {
        return item.content.toLowerCase().includes(searchLower);
      }
      return false;
    });
  }, [displayItems, search]);

  // Auto-scroll to bottom when new events arrive
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
        {filteredItems.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {search.trim() ? "No matching activities" : "Waiting for activity..."}
          </div>
        ) : (
          <div className="font-mono text-xs py-2">
            {filteredItems.map((item, i) => (
              <TreeItem
                key={`${item.kind}-${i}`}
                item={item}
                onToggle={toggleCollapse}
                isCollapsed={item.kind === "agent-header" ? collapsedGroups.has(item.group.id) : false}
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

// ============================================================================
// Tree Rendering Components
// ============================================================================

interface TreeItemProps {
  item: DisplayItem;
  onToggle: (groupId: string) => void;
  isCollapsed: boolean;
}

function TreeItem({ item, onToggle, isCollapsed }: TreeItemProps) {
  if (item.kind === "agent-header") {
    return <AgentHeader group={item.group} onToggle={onToggle} isCollapsed={isCollapsed} />;
  }

  if (item.kind === "agent-child") {
    return <ToolLine event={item.event} isLast={item.isLast} indented />;
  }

  if (item.kind === "standalone-tool") {
    return <ToolLine event={item.event} isLast={true} indented={false} />;
  }

  if (item.kind === "status") {
    return (
      <div className="px-3 py-1 text-gray-500">
        <span className="text-gray-400 mr-2">●</span>
        {item.content}
      </div>
    );
  }

  return null;
}

interface AgentHeaderProps {
  group: AgentGroup;
  onToggle: (groupId: string) => void;
  isCollapsed: boolean;
}

function AgentHeader({ group, onToggle, isCollapsed }: AgentHeaderProps) {
  const statusColor = group.status === "done"
    ? "text-green-600"
    : group.status === "error"
      ? "text-red-600"
      : "text-blue-600";

  const statusIcon = group.status === "done"
    ? "●"
    : group.status === "error"
      ? "●"
      : "○";

  return (
    <div className="px-3 py-1.5 hover:bg-gray-50">
      {/* Main header line */}
      <div
        className="flex items-center cursor-pointer"
        onClick={() => onToggle(group.id)}
      >
        <span className={cn("mr-2", statusColor)}>{statusIcon}</span>
        <span className="font-semibold text-gray-900">{group.label}</span>
        <span className="text-gray-400 mx-2">·</span>
        <span className="text-gray-500">{group.toolCount} tool uses</span>
        {group.inputTokens > 0 && (
          <>
            <span className="text-gray-400 mx-2">·</span>
            <span className="text-purple-600" title="Input/prompt tokens">
              {formatTokens(group.inputTokens)} in
            </span>
          </>
        )}
        {group.outputTokens > 0 && (
          <>
            <span className="text-gray-400 mx-1">/</span>
            <span className="text-gray-500" title="Output tokens">
              {formatTokens(group.outputTokens)} out
            </span>
          </>
        )}
        {group.totalCostUsd !== undefined && (
          <>
            <span className="text-gray-400 mx-2">·</span>
            <span className="text-gray-500">{formatUsd(group.totalCostUsd)}</span>
          </>
        )}
        {isCollapsed && (
          <span className="text-gray-400 ml-2 text-[10px]">(click to expand)</span>
        )}
      </div>
      {/* Status line with tree connector */}
      <div className="flex items-center text-gray-500 pl-4">
        <span className="text-gray-300 mr-2">└</span>
        <span className={cn(
          "px-1.5 py-0.5 rounded text-[10px] font-medium",
          group.status === "done"
            ? "bg-green-100 text-green-700"
            : group.status === "error"
              ? "bg-red-100 text-red-700"
              : "bg-blue-100 text-blue-700"
        )}>
          {group.status === "done" ? "Done" : group.status === "error" ? "Error" : "Running"}
        </span>
      </div>
    </div>
  );
}

interface ToolLineProps {
  event: ProcessedEvent;
  isLast: boolean;
  indented: boolean;
}

function ToolLine({ event, isLast, indented }: ToolLineProps) {
  const outcomeColor = event.outcome === "error"
    ? "text-red-600"
    : event.outcome === "warning"
      ? "text-amber-600"
      : "text-gray-600";

  return (
    <div className={cn("px-3 py-1", indented && "pl-7")}>
      {/* Tool name and arg */}
      <div className="flex items-center">
        {indented && <span className="text-gray-300 mr-2">{isLast ? "└" : "├"}</span>}
        <span className="text-gray-400 mr-2">●</span>
        <span className="font-semibold text-gray-800">{event.toolName}</span>
        {event.primaryArg && (
          <>
            <span className="text-gray-400">(</span>
            <span className="text-blue-600 underline underline-offset-2">{event.primaryArg}</span>
            <span className="text-gray-400">)</span>
          </>
        )}
      </div>
      {/* Result line */}
      <div className={cn("flex items-center pl-4", outcomeColor)}>
        <span className="text-gray-300 mr-2">└</span>
        <span>{event.result}</span>
        {event.durationMs !== undefined && event.durationMs > 100 && (
          <span className="text-gray-400 ml-2 text-[10px]">
            ({event.durationMs >= 1000 ? `${(event.durationMs / 1000).toFixed(1)}s` : `${event.durationMs}ms`})
          </span>
        )}
      </div>
    </div>
  );
}
