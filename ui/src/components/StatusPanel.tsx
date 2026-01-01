import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { PipelineEvent, PipelinePhase, StatusUpdateData, ToolEventData } from "../types";

interface StatusPanelProps {
  events: PipelineEvent[];
  currentPhase: PipelinePhase;
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
      return "Starting feature discovery...";
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

export function StatusPanel({ events, currentPhase }: StatusPanelProps) {
  // Get the most recent status update
  const currentAction = useMemo(() => {
    const statusEvents = events.filter((e) => e.type === "status_update");
    if (statusEvents.length === 0) {
      return getDefaultAction(currentPhase);
    }
    const latest = statusEvents[statusEvents.length - 1];
    const data = latest.data as unknown as StatusUpdateData;
    return data.action || getDefaultAction(currentPhase);
  }, [events, currentPhase]);

  // Get the most recent tool event
  const lastTool = useMemo(() => {
    const toolEvents = events.filter(
      (e) => e.type === "tool_started" || e.type === "tool_completed"
    );
    return toolEvents[toolEvents.length - 1];
  }, [events]);

  const isToolRunning = lastTool?.type === "tool_started";
  const toolData = lastTool?.data as unknown as ToolEventData | undefined;

  return (
    <div className="bg-gray-900 text-white rounded-lg p-4 flex items-center gap-4">
      {/* Phase indicator */}
      <div
        className={cn(
          "w-3 h-3 rounded-full",
          phaseColors[currentPhase],
          "animate-pulse"
        )}
      />

      {/* Phase label and action */}
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-xs text-gray-400 uppercase tracking-wide">
          {phaseLabels[currentPhase]}
        </span>
        <span className="text-sm font-medium truncate">{currentAction}</span>
      </div>

      {/* Tool indicator */}
      {isToolRunning && toolData && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="font-mono">{toolData.toolName}</span>
        </div>
      )}
    </div>
  );
}
