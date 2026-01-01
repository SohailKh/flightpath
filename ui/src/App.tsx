import { useState, useEffect, useCallback } from "react";
import { MessageInput } from "./components/MessageInput";
import { RunList } from "./components/RunList";
import { RunDetail } from "./components/RunDetail";
import { PipelineView } from "./components/PipelineView";
import {
  createRun,
  getRun,
  subscribeToRunEvents,
  createPipeline,
  getPipelines,
} from "./lib/api";
import type { Run, RunEvent, PipelineSummary } from "./types";
import { cn } from "./lib/utils";
import { Button } from "./components/ui/button";

type AppMode = "runs" | "pipeline";

function App() {
  const [mode, setMode] = useState<AppMode>("pipeline");
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Pipeline state
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);

  const selectedRun = runs.find((r) => r.id === selectedRunId);

  // Load existing pipelines on mount
  useEffect(() => {
    getPipelines()
      .then(({ pipelines, activePipelineId }) => {
        setPipelines(pipelines);
        setActivePipelineId(activePipelineId);
      })
      .catch(console.error);
  }, []);

  // Handle new run submission
  const handleSubmit = useCallback(async (message: string) => {
    setIsLoading(true);
    try {
      const { runId } = await createRun(message);

      // Create a placeholder run
      const newRun: Run = {
        id: runId,
        createdAt: new Date().toISOString(),
        status: "queued",
        input: { message },
        events: [],
      };

      setRuns((prev) => [newRun, ...prev]);
      setSelectedRunId(runId);
      setEvents([]);

      // Subscribe to events
      subscribeToRunEvents(runId, {
        onEvent: (event) => {
          setEvents((prev) => [...prev, event]);

          // Update run status based on event
          setRuns((prev) =>
            prev.map((r) => {
              if (r.id !== runId) return r;
              const status =
                event.type === "completed"
                  ? "succeeded"
                  : event.type === "failed"
                    ? "failed"
                    : event.type === "calling_agent"
                      ? "running"
                      : r.status;
              return { ...r, status, events: [...r.events, event] };
            })
          );
        },
        onDone: async () => {
          // Fetch final run state
          try {
            const finalRun = await getRun(runId);
            setRuns((prev) =>
              prev.map((r) => (r.id === runId ? finalRun : r))
            );
          } catch (err) {
            console.error("Failed to fetch final run state:", err);
          }
        },
        onError: (error) => {
          console.error("Event stream error:", error);
          setRuns((prev) =>
            prev.map((r) =>
              r.id === runId
                ? { ...r, status: "failed", error: { message: error.message } }
                : r
            )
          );
        },
      });
    } catch (err) {
      console.error("Failed to create run:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load events when selecting a different run
  useEffect(() => {
    if (selectedRun) {
      setEvents(selectedRun.events);
    }
  }, [selectedRunId]);

  // Handle pipeline creation
  const handleStartPipeline = useCallback(async (initialPrompt: string) => {
    setIsLoading(true);
    try {
      const { pipelineId } = await createPipeline(initialPrompt);
      setActivePipelineId(pipelineId);
      // Refresh pipelines list
      const { pipelines } = await getPipelines();
      setPipelines(pipelines);
    } catch (err) {
      console.error("Failed to create pipeline:", err);
      alert(err instanceof Error ? err.message : "Failed to create pipeline");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handlePipelineClose = useCallback(() => {
    setActivePipelineId(null);
    // Refresh pipelines list
    getPipelines()
      .then(({ pipelines, activePipelineId }) => {
        setPipelines(pipelines);
        setActivePipelineId(activePipelineId);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">
          Flightpath
        </h1>
        {/* Mode toggle */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMode("pipeline")}
            className={cn(
              "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
              mode === "pipeline"
                ? "bg-blue-100 text-blue-700"
                : "text-gray-600 hover:text-gray-900"
            )}
          >
            Feature Pipeline
          </button>
          <button
            onClick={() => setMode("runs")}
            className={cn(
              "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
              mode === "runs"
                ? "bg-blue-100 text-blue-700"
                : "text-gray-600 hover:text-gray-900"
            )}
          >
            Agent Runs
          </button>
        </div>
      </header>

      {mode === "pipeline" ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {activePipelineId ? (
            <main className="flex-1 p-6 overflow-hidden">
              <PipelineView
                pipelineId={activePipelineId}
                onClose={handlePipelineClose}
              />
            </main>
          ) : (
            <main className="flex-1 flex flex-col items-center justify-center p-6">
              <div className="max-w-xl w-full space-y-6">
                <div className="text-center">
                  <h2 className="text-2xl font-semibold text-gray-900 mb-2">
                    Start a Feature Pipeline
                  </h2>
                  <p className="text-gray-600">
                    Describe the feature you want to build. The AI will ask
                    clarifying questions, break it down into requirements, and
                    implement it step by step.
                  </p>
                </div>
                <MessageInput
                  onSubmit={handleStartPipeline}
                  disabled={isLoading}
                  placeholder="Describe the feature you want to build..."
                  buttonText={isLoading ? "Starting..." : "Start Pipeline"}
                />
                {/* Previous pipelines */}
                {pipelines.length > 0 && (
                  <div className="mt-8">
                    <h3 className="text-sm font-medium text-gray-700 mb-3">
                      Previous Pipelines
                    </h3>
                    <div className="space-y-2">
                      {pipelines.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setActivePipelineId(p.id)}
                          className="w-full text-left p-3 bg-white rounded-lg border border-gray-200 hover:border-blue-300 transition-colors"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-gray-900">
                              Pipeline {p.id.slice(0, 8)}
                            </span>
                            <PipelineStatusBadge status={p.status} />
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {new Date(p.createdAt).toLocaleString()}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </main>
          )}
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left sidebar - Run list */}
          <aside className="w-80 bg-white border-r border-gray-200 flex flex-col">
            <div className="p-4 border-b border-gray-200">
              <h2 className="text-sm font-medium text-gray-700">Recent Runs</h2>
            </div>
            <div className="flex-1 overflow-y-auto">
              <RunList
                runs={runs}
                selectedId={selectedRunId}
                onSelect={setSelectedRunId}
              />
            </div>
          </aside>

          {/* Main content */}
          <main className="flex-1 flex flex-col p-6 overflow-hidden">
            {/* Input area */}
            <div className="mb-6">
              <MessageInput onSubmit={handleSubmit} disabled={isLoading} />
            </div>

            {/* Run detail */}
            <div className="flex-1 overflow-hidden">
              {selectedRun ? (
                <RunDetail run={selectedRun} events={events} />
              ) : (
                <div className="h-full flex items-center justify-center text-gray-400">
                  <div className="text-center">
                    <p className="text-lg">No run selected</p>
                    <p className="text-sm mt-1">
                      Enter a message above to start a new run
                    </p>
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

function PipelineStatusBadge({
  status,
}: {
  status: PipelineSummary["status"];
}) {
  const colors: Record<PipelineSummary["status"], string> = {
    qa: "bg-blue-100 text-blue-700",
    planning: "bg-purple-100 text-purple-700",
    executing: "bg-yellow-100 text-yellow-700",
    testing: "bg-cyan-100 text-cyan-700",
    paused: "bg-gray-100 text-gray-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    aborted: "bg-orange-100 text-orange-700",
  };

  return (
    <span
      className={cn(
        "px-2 py-0.5 rounded-full text-xs font-medium",
        colors[status]
      )}
    >
      {status}
    </span>
  );
}

export default App;
