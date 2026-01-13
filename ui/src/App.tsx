import { useState, useEffect, useCallback } from "react";
import { MessageInput } from "./components/MessageInput";
import { PipelineView } from "./components/PipelineView";
import {
  createPipeline,
  getPipelines,
  abortPipeline,
  PipelineConflictError,
} from "./lib/api";
import type { PipelineSummary } from "./types";
import { cn } from "./lib/utils";

function App() {
  const [activePipelineId, setActivePipelineId] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load existing pipelines on mount
  useEffect(() => {
    getPipelines()
      .then(({ pipelines, activePipelineId }) => {
        setPipelines(pipelines);
        setActivePipelineId(activePipelineId);
      })
      .catch(console.error);
  }, []);

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
      if (err instanceof PipelineConflictError) {
        const shouldAbort = confirm(
          "A pipeline is already active. Would you like to abort it and start a new one?"
        );
        if (shouldAbort) {
          try {
            await abortPipeline(err.activePipelineId);
            // Retry creating the pipeline
            const { pipelineId } = await createPipeline(initialPrompt);
            setActivePipelineId(pipelineId);
            const { pipelines } = await getPipelines();
            setPipelines(pipelines);
          } catch (retryErr) {
            console.error("Failed to abort and create pipeline:", retryErr);
            alert(retryErr instanceof Error ? retryErr.message : "Failed to create pipeline");
          }
        }
      } else {
        console.error("Failed to create pipeline:", err);
        alert(err instanceof Error ? err.message : "Failed to create pipeline");
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handlePipelineClose = useCallback(() => {
    setActivePipelineId(null);
    // Refresh pipelines list only, don't restore activePipelineId
    getPipelines()
      .then(({ pipelines }) => {
        setPipelines(pipelines);
      })
      .catch(console.error);
  }, []);

  return (
    <div className="h-screen bg-gray-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-gray-900">
          Flightpath
        </h1>
      </header>

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
                defaultValue={"an app where users can tap a button to randomly change the number for everyone else"}
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
    exploring: "bg-indigo-100 text-indigo-700",
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
