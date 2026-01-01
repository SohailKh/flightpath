import { useRef, useEffect, useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { PipelineEvent, PipelinePhase, ToolEventData, StatusUpdateData } from "../types";
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

export function ActivityStream({ events, maxItems = 100 }: ActivityStreamProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");

  // Filter to activity events
  const activityEvents = useMemo(() => {
    return events
      .filter(
        (e) =>
          e.type === "tool_started" ||
          e.type === "tool_completed" ||
          e.type === "tool_error" ||
          e.type.endsWith("_started") ||
          e.type.endsWith("_completed")
      )
      .slice(-maxItems);
  }, [events, maxItems]);

  // Apply text search filter
  const filteredEvents = useMemo(() => {
    if (!search.trim()) return activityEvents;
    const searchLower = search.toLowerCase();
    return activityEvents.filter((event) => {
      const data = event.data as unknown as ToolEventData;
      const searchableText = [
        event.type,
        data.toolName,
        data.error,
        (data.args as Record<string, unknown>)?.file_path,
        (data.args as Record<string, unknown>)?.path,
        (data.args as Record<string, unknown>)?.command,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchableText.includes(searchLower);
    });
  }, [activityEvents, search]);

  // Auto-scroll to bottom when new events arrive (not when filtering)
  useEffect(() => {
    if (!search.trim()) {
      scrollRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [activityEvents.length, search]);

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
      <CardContent className="flex-1 overflow-y-auto p-0">
        {filteredEvents.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            {search.trim() ? "No matching activities" : "Waiting for activity..."}
          </div>
        ) : (
          <div className="font-mono text-xs">
            {filteredEvents.map((event, i) => (
              <ActivityItem key={`${event.ts}-${i}`} event={event} />
            ))}
            <div ref={scrollRef} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityItem({ event }: { event: PipelineEvent }) {
  const data = event.data as unknown as ToolEventData;
  const time = new Date(event.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const getIcon = () => {
    if (event.type === "tool_started") return ">";
    if (event.type === "tool_completed") return "\u2713";
    if (event.type === "tool_error") return "\u2717";
    if (event.type.endsWith("_started")) return "\u25CB";
    if (event.type.endsWith("_completed")) return "\u2713";
    return "-";
  };

  const getColor = () => {
    if (event.type === "tool_error") return "text-red-600 bg-red-50";
    if (event.type === "tool_completed") return "text-green-700";
    if (event.type === "tool_started") return "text-blue-600";
    if (event.type.endsWith("_completed")) return "text-green-600";
    return "text-gray-600";
  };

  const getMessage = () => {
    if (event.type === "tool_started" && data.toolName) {
      const args = data.args as Record<string, unknown> | undefined;
      const path = args?.file_path || args?.path || "";
      const cmd = args?.command;
      if (path) return `${data.toolName} ${truncatePath(String(path))}`;
      if (cmd) return `${data.toolName} ${truncateCmd(String(cmd))}`;
      return data.toolName;
    }
    if (event.type === "tool_completed" && data.toolName) {
      return `${data.toolName} done (${data.durationMs}ms)`;
    }
    if (event.type === "tool_error" && data.toolName) {
      return `${data.toolName} failed: ${data.error}`;
    }
    // Phase events
    return event.type.replace(/_/g, " ");
  };

  return (
    <div
      className={cn(
        "flex items-start gap-2 px-3 py-1 border-b border-gray-100 hover:bg-gray-50",
        getColor()
      )}
    >
      <span className="text-gray-400 w-16 flex-shrink-0">{time}</span>
      <span className="w-4">{getIcon()}</span>
      <span className="flex-1 truncate">{getMessage()}</span>
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
