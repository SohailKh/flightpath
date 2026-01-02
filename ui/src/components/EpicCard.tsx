import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { Epic, Requirement, PipelineEvent } from "../types";

interface EpicCardProps {
  epic: Epic;
  requirements: Requirement[];
  events: PipelineEvent[];
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}

export function EpicCard({
  epic,
  requirements,
  events,
  isActive,
  isExpanded,
  onToggle,
}: EpicCardProps) {
  // Get recent activity for this epic (last 3 events)
  const recentActivity = useMemo(() => {
    return events
      .filter((e) => {
        if (
          e.type === "requirement_started" ||
          e.type === "requirement_completed" ||
          e.type === "requirement_failed"
        ) {
          return epic.requirementIds.includes(String(e.data.requirementId));
        }
        return false;
      })
      .slice(-3);
  }, [events, epic.requirementIds]);

  // Current requirement being worked on
  const currentRequirement = requirements.find((r) => r.status === "in_progress");

  // Get status icon and colors
  const getStatusDisplay = () => {
    switch (epic.status) {
      case "completed":
        return { icon: "✓", bgColor: "bg-green-50", borderColor: "border-green-300" };
      case "in_progress":
        return { icon: "▶", bgColor: "bg-blue-50", borderColor: "border-blue-300" };
      case "partial":
        return { icon: "◐", bgColor: "bg-yellow-50", borderColor: "border-yellow-300" };
      default:
        return { icon: "○", bgColor: "bg-white", borderColor: "border-gray-200" };
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <div
      className={cn(
        "border rounded-lg transition-all",
        statusDisplay.bgColor,
        statusDisplay.borderColor,
        isActive && "ring-2 ring-blue-400"
      )}
    >
      {/* Header (always visible) */}
      <button
        onClick={onToggle}
        className="w-full p-4 flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span
            className={cn(
              "flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-sm",
              epic.status === "completed" && "bg-green-100 text-green-700",
              epic.status === "in_progress" && "bg-blue-100 text-blue-700",
              epic.status === "partial" && "bg-yellow-100 text-yellow-700",
              epic.status === "pending" && "bg-gray-100 text-gray-500"
            )}
          >
            {statusDisplay.icon}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-gray-900 truncate">{epic.title}</h3>
            <p className="text-sm text-gray-500 truncate">{epic.goal}</p>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0 ml-2">
          {/* Progress pill */}
          <span
            className={cn(
              "px-2 py-0.5 rounded-full text-xs font-medium",
              epic.progress.completed === epic.progress.total && epic.progress.total > 0
                ? "bg-green-100 text-green-700"
                : epic.progress.inProgress > 0
                  ? "bg-blue-100 text-blue-700"
                  : "bg-gray-100 text-gray-600"
            )}
          >
            {epic.progress.completed}/{epic.progress.total}
          </span>

          {/* Expand chevron */}
          <svg
            className={cn(
              "w-4 h-4 text-gray-400 transition-transform",
              isExpanded && "rotate-180"
            )}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="px-4 pb-4 border-t pt-3 space-y-3">
          {/* Current work */}
          {currentRequirement && (
            <div className="bg-blue-50 border border-blue-200 p-3 rounded-lg">
              <div className="text-xs font-medium text-blue-600 uppercase mb-1">
                Currently Working On
              </div>
              <div className="text-sm text-blue-900 font-medium">
                {currentRequirement.title}
              </div>
            </div>
          )}

          {/* Requirements list */}
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-gray-500 uppercase">
              Requirements
            </div>
            {requirements.map((req) => (
              <RequirementRow key={req.id} requirement={req} />
            ))}
          </div>

          {/* Recent activity */}
          {recentActivity.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-gray-500 uppercase">
                Recent Activity
              </div>
              {recentActivity.map((event, i) => (
                <div key={i} className="text-xs text-gray-500 flex items-center gap-2">
                  <span className="text-gray-300">•</span>
                  {formatEventForDisplay(event)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RequirementRow({ requirement }: { requirement: Requirement }) {
  const getStatusIcon = () => {
    switch (requirement.status) {
      case "completed":
        return { icon: "✓", className: "text-green-600" };
      case "failed":
        return { icon: "✕", className: "text-red-600" };
      case "in_progress":
        return { icon: "▶", className: "text-blue-600" };
      default:
        return { icon: "○", className: "text-gray-400" };
    }
  };

  const status = getStatusIcon();

  return (
    <div className="flex items-center gap-2 text-sm py-1">
      <span className={cn("flex-shrink-0", status.className)}>{status.icon}</span>
      <span
        className={cn(
          "truncate",
          requirement.status === "completed" && "text-gray-500",
          requirement.status === "in_progress" && "text-blue-900 font-medium",
          requirement.status === "failed" && "text-red-700",
          requirement.status === "pending" && "text-gray-600"
        )}
      >
        {requirement.title}
      </span>
    </div>
  );
}

function formatEventForDisplay(event: PipelineEvent): string {
  const time = new Date(event.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

  switch (event.type) {
    case "requirement_started":
      return `Started at ${time}`;
    case "requirement_completed":
      return `Completed at ${time}`;
    case "requirement_failed":
      return `Failed at ${time}`;
    default:
      return `${event.type} at ${time}`;
  }
}
