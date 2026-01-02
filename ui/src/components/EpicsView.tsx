import { useState, useEffect, useMemo } from "react";
import type { Epic, Requirement, PipelineEvent } from "../types";
import { EpicCard } from "./EpicCard";

interface EpicsViewProps {
  epics: Epic[];
  requirements: Requirement[];
  events: PipelineEvent[];
}

export function EpicsView({ epics, requirements, events }: EpicsViewProps) {
  const [expandedEpicId, setExpandedEpicId] = useState<string | null>(null);

  // Find the current active epic (one with in_progress requirement)
  const activeEpicId = useMemo(() => {
    const inProgressReq = requirements.find((r) => r.status === "in_progress");
    if (!inProgressReq) return null;
    return epics.find((e) => e.requirementIds.includes(inProgressReq.id))?.id ?? null;
  }, [requirements, epics]);

  // Auto-expand active epic when it changes
  useEffect(() => {
    if (activeEpicId) {
      setExpandedEpicId(activeEpicId);
    }
  }, [activeEpicId]);

  // Sort epics by priority
  const sortedEpics = useMemo(() => {
    return [...epics].sort((a, b) => a.priority - b.priority);
  }, [epics]);

  if (epics.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400 text-sm">
        No epics defined
      </div>
    );
  }

  return (
    <div className="p-3 space-y-3 overflow-y-auto h-full">
      {sortedEpics.map((epic) => {
        // Get requirements for this epic
        const epicRequirements = requirements.filter((r) =>
          epic.requirementIds.includes(r.id)
        );

        return (
          <EpicCard
            key={epic.id}
            epic={epic}
            requirements={epicRequirements}
            events={events}
            isActive={epic.id === activeEpicId}
            isExpanded={epic.id === expandedEpicId}
            onToggle={() =>
              setExpandedEpicId(expandedEpicId === epic.id ? null : epic.id)
            }
          />
        );
      })}
    </div>
  );
}
