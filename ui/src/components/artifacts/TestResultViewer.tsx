import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { ArtifactRef } from "../../types";
import { getArtifactJson } from "../../lib/api";

interface TestResultViewerProps {
  pipelineId: string;
  testResults: ArtifactRef[];
}

interface TestResult {
  requirementId: string;
  passed: boolean;
  timestamp: string;
  criteria: Array<{
    criterion: string;
    passed: boolean;
  }>;
  failureReason?: string;
}

interface TestResultItemProps {
  pipelineId: string;
  artifact: ArtifactRef;
}

function TestResultItem({ pipelineId, artifact }: TestResultItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && !result && !loading) {
      setLoading(true);
      getArtifactJson<TestResult>(pipelineId, artifact.id)
        .then(setResult)
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, [expanded, result, loading, pipelineId, artifact.id]);

  return (
    <div className="border rounded overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "w-full flex items-center justify-between px-3 py-2 text-left text-sm",
          "hover:bg-gray-50 transition-colors"
        )}
      >
        <div className="flex items-center gap-2">
          {/* Expand/collapse indicator */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={cn(
              "transition-transform",
              expanded && "rotate-90"
            )}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>

          {/* Status indicator */}
          {result ? (
            <span
              className={cn(
                "w-2 h-2 rounded-full",
                result.passed ? "bg-green-500" : "bg-red-500"
              )}
            />
          ) : (
            <span className="w-2 h-2 rounded-full bg-gray-300" />
          )}

          <span className="font-medium">
            {artifact.requirementId || "Test Result"}
          </span>
        </div>

        <span className="text-xs text-gray-500">
          {new Date(artifact.createdAt).toLocaleTimeString()}
        </span>
      </button>

      {expanded && (
        <div className="border-t px-3 py-2 bg-gray-50">
          {loading && (
            <div className="text-gray-500 text-xs">Loading...</div>
          )}

          {error && (
            <div className="text-red-500 text-xs">Error: {error}</div>
          )}

          {result && (
            <div className="space-y-2">
              {/* Status badge */}
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "px-2 py-0.5 rounded text-xs font-medium",
                    result.passed
                      ? "bg-green-100 text-green-700"
                      : "bg-red-100 text-red-700"
                  )}
                >
                  {result.passed ? "PASSED" : "FAILED"}
                </span>
                <span className="text-xs text-gray-500">
                  {new Date(result.timestamp).toLocaleString()}
                </span>
              </div>

              {/* Failure reason */}
              {result.failureReason && (
                <div className="text-sm text-red-600 bg-red-50 rounded p-2">
                  {result.failureReason}
                </div>
              )}

              {/* Criteria list */}
              {result.criteria.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-gray-600">
                    Acceptance Criteria:
                  </div>
                  {result.criteria.map((c, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 text-xs"
                    >
                      <span
                        className={cn(
                          "mt-0.5",
                          c.passed ? "text-green-500" : "text-red-500"
                        )}
                      >
                        {c.passed ? "✓" : "✗"}
                      </span>
                      <span className="text-gray-700">{c.criterion}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TestResultViewer({
  pipelineId,
  testResults,
}: TestResultViewerProps) {
  if (testResults.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {testResults.map((result) => (
        <TestResultItem
          key={result.id}
          pipelineId={pipelineId}
          artifact={result}
        />
      ))}
    </div>
  );
}
