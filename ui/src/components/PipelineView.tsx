import { useState, useEffect, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { Pipeline, PipelineEvent, PipelineStatus, TokenUsageData } from "../types";
import {
  getPipeline,
  subscribeToPipelineEvents,
  pausePipeline,
  abortPipeline,
  resumePipeline,
  goPipeline,
} from "../lib/api";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { PipelineChat } from "./PipelineChat";
import { ActivityStream } from "./ActivityStream";
import { EpicsProgressPanel } from "./EpicsProgressPanel";
import { ArtifactPanel } from "./artifacts";
import { FlowSuggestionsButton } from "./FlowSuggestionsButton";

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
          event.type === "resumed" ||
          event.type === "screenshot_captured"
        ) {
          getPipeline(pipelineId).then(setPipeline).catch(console.error);
        }
      },
      onDone: () => {
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

  const handleGo = useCallback(async () => {
    try {
      await goPipeline(pipelineId);
      // Refresh pipeline state after go
      const updated = await getPipeline(pipelineId);
      setPipeline(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to go");
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

  // Aggregate token usage from all token_usage events
  const totalTokens = useMemo(() => {
    const tokenEvents = events.filter((e) => e.type === "token_usage");
    let input = 0,
      output = 0,
      cost = 0;
    for (const event of tokenEvents) {
      const data = event.data as TokenUsageData;
      input += data.inputTokens ?? 0;
      output += data.outputTokens ?? 0;
      cost += data.totalCostUsd ?? 0;
    }
    return { input, output, cost };
  }, [events]);

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
          {(totalTokens.input > 0 || totalTokens.output > 0) && (
            <div className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded font-mono">
              {(totalTokens.input + totalTokens.output).toLocaleString()} tokens
              {totalTokens.cost > 0 && ` · $${totalTokens.cost.toFixed(2)}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Go button - for orphaned pipelines (e.g., after server restart) */}
          {!isTerminal && !pipeline.isRunning && pipeline.status !== "paused" && pipeline.phase.current !== "qa" && (
            <Button variant="default" size="sm" onClick={handleGo}>
              Go
            </Button>
          )}
          {!isTerminal && pipeline.status !== "paused" && pipeline.isRunning && (
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
          {isTerminal && (
            <FlowSuggestionsButton pipelineId={pipelineId} />
          )}
          {onClose && (
            <>
              <Button size="sm" onClick={onClose}>
                New Pipeline
              </Button>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            </>
          )}
        </div>
      </div>

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
          <CardContent className="py-3 flex items-center justify-between">
            <p className="text-red-800 text-sm">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-600 hover:text-red-800 ml-4"
              aria-label="Dismiss error"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: PipelineStatus }) {
  const colors: Record<PipelineStatus, string> = {
    qa: "bg-blue-100 text-blue-700",
    exploring: "bg-indigo-100 text-indigo-700",
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
    exploring: "Exploring",
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
  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Side-by-side content area */}
      <div className="flex-1 flex gap-4 min-h-0">
        {/* Activity Stream - Left */}
        <div className="w-1/2 h-full">
          <ActivityStream events={events} currentPhase={pipeline.phase.current} />
        </div>

        {/* Epics Progress Panel - Right (with Messages tab) */}
        <div className="w-1/2 h-full">
          <EpicsProgressPanel
            events={events}
            pipelineId={pipeline.id}
            requirements={pipeline.requirements}
            epics={pipeline.epics}
            artifacts={pipeline.artifacts}
          />
        </div>
      </div>

      {/* Artifacts Panel - Full width below */}
      {pipeline.artifacts && pipeline.artifacts.length > 0 && (
        <ArtifactPanel
          pipelineId={pipeline.id}
          artifacts={pipeline.artifacts}
          requirements={pipeline.requirements}
        />
      )}
    </div>
  );
}
