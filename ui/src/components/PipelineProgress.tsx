import { cn } from "@/lib/utils";
import type { Pipeline, PipelinePhase } from "../types";

interface PipelineProgressProps {
  pipeline: Pipeline;
}

function getFailureReason(pipeline: Pipeline): string | null {
  // Find the most recent failure event
  const failureEvent = [...pipeline.events]
    .reverse()
    .find((e) => e.type === "pipeline_failed" || e.type === "requirement_failed");

  if (failureEvent && "error" in failureEvent.data) {
    return String(failureEvent.data.error);
  }
  return null;
}

const phases: PipelinePhase[] = ["qa", "exploring", "planning", "executing", "testing"];

const phaseLabels: Record<PipelinePhase, string> = {
  qa: "Q&A",
  exploring: "Explore",
  planning: "Plan",
  executing: "Execute",
  testing: "Test",
};

export function PipelineProgress({ pipeline }: PipelineProgressProps) {
  const currentPhaseIndex = phases.indexOf(pipeline.phase.current);
  const isTerminal =
    pipeline.status === "completed" ||
    pipeline.status === "failed" ||
    pipeline.status === "aborted";

  const getPhaseStatus = (
    phase: PipelinePhase,
    index: number
  ): "completed" | "current" | "pending" => {
    if (isTerminal && pipeline.status === "completed") {
      return "completed";
    }
    if (index < currentPhaseIndex) {
      return "completed";
    }
    if (index === currentPhaseIndex) {
      return "current";
    }
    return "pending";
  };

  return (
    <div className="bg-gray-50 rounded-lg p-4">
      {/* Phase progress bar */}
      <div className="flex items-center justify-between mb-3">
        {phases.map((phase, index) => {
          const status = getPhaseStatus(phase, index);
          return (
            <div key={phase} className="flex items-center flex-1">
              {/* Phase circle */}
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium",
                  status === "completed" && "bg-green-500 text-white",
                  status === "current" && "bg-blue-500 text-white",
                  status === "pending" && "bg-gray-200 text-gray-500"
                )}
              >
                {status === "completed" ? (
                  <span>&#10003;</span>
                ) : (
                  index + 1
                )}
              </div>
              {/* Phase label */}
              <span
                className={cn(
                  "ml-2 text-sm font-medium",
                  status === "completed" && "text-green-700",
                  status === "current" && "text-blue-700",
                  status === "pending" && "text-gray-400"
                )}
              >
                {phaseLabels[phase]}
              </span>
              {/* Connector line */}
              {index < phases.length - 1 && (
                <div
                  className={cn(
                    "flex-1 h-0.5 mx-3",
                    index < currentPhaseIndex ? "bg-green-500" : "bg-gray-200"
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Requirement progress (if in implementation phase) */}
      {pipeline.phase.current !== "qa" &&
        pipeline.phase.totalRequirements > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <div className="flex items-center justify-between text-sm mb-2">
              <span className="text-gray-600">Requirements Progress</span>
              <span className="text-gray-900 font-medium">
                {pipeline.requirements.filter((r) => r.status === "completed")
                  .length}{" "}
                / {pipeline.phase.totalRequirements}
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-green-500 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${
                    (pipeline.requirements.filter(
                      (r) => r.status === "completed"
                    ).length /
                      pipeline.phase.totalRequirements) *
                    100
                  }%`,
                }}
              />
            </div>
            {/* Retry indicator */}
            {pipeline.phase.retryCount > 0 && (
              <div className="text-xs text-yellow-600 mt-2">
                Retry attempt {pipeline.phase.retryCount} of 3
              </div>
            )}
          </div>
        )}

      {/* Status messages */}
      {pipeline.status === "paused" && (
        <div className="mt-3 text-sm text-gray-600 bg-gray-100 rounded px-3 py-2">
          Pipeline is paused. Click Resume to continue.
        </div>
      )}
      {pipeline.status === "completed" && (
        <div className="mt-3 text-sm text-green-700 bg-green-50 rounded px-3 py-2">
          All requirements have been implemented!
        </div>
      )}
      {pipeline.status === "failed" && (
        <div className="mt-3 text-sm text-red-700 bg-red-50 rounded px-3 py-2">
          <div className="font-medium">Pipeline failed</div>
          {getFailureReason(pipeline)}
        </div>
      )}
      {pipeline.status === "aborted" && (
        <div className="mt-3 text-sm text-orange-700 bg-orange-50 rounded px-3 py-2">
          Pipeline was aborted by user.
        </div>
      )}
    </div>
  );
}
