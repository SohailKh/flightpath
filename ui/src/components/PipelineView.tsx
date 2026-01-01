import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Pipeline, PipelineEvent, PipelineStatus } from "../types";
import {
  getPipeline,
  subscribeToPipelineEvents,
  pausePipeline,
  abortPipeline,
  resumePipeline,
} from "../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { PipelineChat } from "./PipelineChat";
import { PipelineProgress } from "./PipelineProgress";

interface PipelineViewProps {
  pipelineId: string;
  onClose?: () => void;
}

export function PipelineView({ pipelineId, onClose }: PipelineViewProps) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Load initial pipeline data
  useEffect(() => {
    getPipeline(pipelineId)
      .then((p) => {
        setPipeline(p);
        setEvents(p.events);
      })
      .catch((err) => setError(err.message));
  }, [pipelineId]);

  // Subscribe to pipeline events
  useEffect(() => {
    const unsubscribe = subscribeToPipelineEvents(pipelineId, {
      onEvent: (event) => {
        setEvents((prev) => [...prev, event]);
        // Refresh pipeline state on significant events
        if (
          event.type.includes("completed") ||
          event.type.includes("failed") ||
          event.type === "requirements_ready" ||
          event.type === "paused" ||
          event.type === "resumed"
        ) {
          getPipeline(pipelineId).then(setPipeline).catch(console.error);
        }
      },
      onDone: (status) => {
        getPipeline(pipelineId).then(setPipeline).catch(console.error);
      },
      onError: (err) => setError(err.message),
    });

    return unsubscribe;
  }, [pipelineId]);

  const handlePause = useCallback(async () => {
    try {
      await pausePipeline(pipelineId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to pause");
    }
  }, [pipelineId]);

  const handleAbort = useCallback(async () => {
    if (!confirm("Are you sure you want to abort this pipeline?")) return;
    try {
      await abortPipeline(pipelineId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to abort");
    }
  }, [pipelineId]);

  const handleResume = useCallback(async () => {
    try {
      await resumePipeline(pipelineId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume");
    }
  }, [pipelineId]);

  if (!pipeline) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">
          {error ? `Error: ${error}` : "Loading pipeline..."}
        </div>
      </div>
    );
  }

  const isTerminal =
    pipeline.status === "completed" ||
    pipeline.status === "failed" ||
    pipeline.status === "aborted";

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header with status and controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusBadge status={pipeline.status} />
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Feature Pipeline
            </h2>
            <p className="text-sm text-gray-500">
              {new Date(pipeline.createdAt).toLocaleString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isTerminal && pipeline.status !== "paused" && (
            <Button variant="outline" size="sm" onClick={handlePause}>
              Pause
            </Button>
          )}
          {pipeline.status === "paused" && (
            <Button variant="outline" size="sm" onClick={handleResume}>
              Resume
            </Button>
          )}
          {!isTerminal && (
            <Button variant="destructive" size="sm" onClick={handleAbort}>
              Abort
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>

      {/* Progress indicator */}
      <PipelineProgress pipeline={pipeline} />

      {/* Main content area */}
      <div className="flex-1 overflow-hidden">
        {pipeline.phase.current === "qa" ? (
          <PipelineChat pipelineId={pipelineId} events={events} />
        ) : (
          <ImplementationView pipeline={pipeline} events={events} />
        )}
      </div>

      {/* Error display */}
      {error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-3">
            <p className="text-red-800 text-sm">{error}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: PipelineStatus }) {
  const colors: Record<PipelineStatus, string> = {
    qa: "bg-blue-100 text-blue-700",
    planning: "bg-purple-100 text-purple-700",
    executing: "bg-yellow-100 text-yellow-700",
    testing: "bg-cyan-100 text-cyan-700",
    paused: "bg-gray-100 text-gray-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    aborted: "bg-orange-100 text-orange-700",
  };

  const labels: Record<PipelineStatus, string> = {
    qa: "Q&A",
    planning: "Planning",
    executing: "Executing",
    testing: "Testing",
    paused: "Paused",
    completed: "Completed",
    failed: "Failed",
    aborted: "Aborted",
  };

  return (
    <span
      className={cn(
        "px-2 py-1 rounded-full text-xs font-medium",
        colors[status]
      )}
    >
      {labels[status]}
    </span>
  );
}

function ImplementationView({
  pipeline,
  events,
}: {
  pipeline: Pipeline;
  events: PipelineEvent[];
}) {
  // Filter to implementation-related events
  const implEvents = events.filter(
    (e) =>
      e.type.includes("planning") ||
      e.type.includes("executing") ||
      e.type.includes("testing") ||
      e.type.includes("requirement") ||
      e.type === "agent_message" ||
      e.type === "test_passed" ||
      e.type === "test_failed" ||
      e.type === "retry_started"
  );

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Requirements list */}
      {pipeline.requirements.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">
              Requirements ({pipeline.phase.requirementIndex + 1} /{" "}
              {pipeline.phase.totalRequirements})
            </CardTitle>
          </CardHeader>
          <CardContent className="max-h-48 overflow-y-auto">
            <div className="space-y-2">
              {pipeline.requirements.map((req, i) => (
                <div
                  key={req.id}
                  className={cn(
                    "flex items-center gap-2 text-sm py-1",
                    i === pipeline.phase.requirementIndex && "font-medium"
                  )}
                >
                  <RequirementStatusIcon status={req.status} />
                  <span
                    className={cn(
                      req.status === "completed" && "text-green-700",
                      req.status === "failed" && "text-red-700",
                      req.status === "in_progress" && "text-blue-700"
                    )}
                  >
                    {req.title}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Event feed */}
      <Card className="flex-1 overflow-hidden flex flex-col">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Activity</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto">
          <div className="space-y-2">
            {implEvents.map((event, i) => (
              <EventItem key={i} event={event} />
            ))}
            {implEvents.length === 0 && (
              <div className="text-gray-400 text-sm">
                Waiting for implementation to start...
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function RequirementStatusIcon({
  status,
}: {
  status: "pending" | "in_progress" | "completed" | "failed";
}) {
  switch (status) {
    case "completed":
      return <span className="text-green-500">&#10003;</span>;
    case "failed":
      return <span className="text-red-500">&#10007;</span>;
    case "in_progress":
      return <span className="text-blue-500 animate-pulse">&#8226;</span>;
    default:
      return <span className="text-gray-300">&#9675;</span>;
  }
}

function EventItem({ event }: { event: PipelineEvent }) {
  const getEventLabel = (type: PipelineEvent["type"]): string => {
    const labels: Partial<Record<PipelineEvent["type"], string>> = {
      planning_started: "Planning",
      planning_completed: "Plan Ready",
      executing_started: "Executing",
      executing_completed: "Code Written",
      testing_started: "Testing",
      testing_completed: "Tests Done",
      requirement_started: "Starting",
      requirement_completed: "Completed",
      requirement_failed: "Failed",
      test_passed: "Test Passed",
      test_failed: "Test Failed",
      retry_started: "Retrying",
      agent_message: "Agent",
    };
    return labels[type] || type;
  };

  const getEventColor = (type: PipelineEvent["type"]): string => {
    if (type.includes("completed") || type === "test_passed") {
      return "text-green-600";
    }
    if (type.includes("failed")) {
      return "text-red-600";
    }
    if (type.includes("started")) {
      return "text-blue-600";
    }
    if (type === "retry_started") {
      return "text-yellow-600";
    }
    return "text-gray-600";
  };

  return (
    <div className="flex gap-3 text-sm py-2 border-b border-gray-100 last:border-0">
      <span className="text-gray-400 text-xs font-mono w-20 flex-shrink-0">
        {new Date(event.ts).toLocaleTimeString()}
      </span>
      <span className={cn("font-medium w-24 flex-shrink-0", getEventColor(event.type))}>
        {getEventLabel(event.type)}
      </span>
      <span className="text-gray-600 flex-1">
        {formatEventContent(event)}
      </span>
    </div>
  );
}

function formatEventContent(event: PipelineEvent): string {
  const data = event.data;

  if (event.type === "agent_message" && "content" in data) {
    const content = String(data.content);
    return content.length > 100 ? content.slice(0, 100) + "..." : content;
  }

  if ("requirementId" in data) {
    return String(data.requirementId);
  }

  if ("error" in data) {
    return String(data.error);
  }

  if ("attempt" in data && "maxAttempts" in data) {
    return `Attempt ${data.attempt} of ${data.maxAttempts}`;
  }

  return "";
}
