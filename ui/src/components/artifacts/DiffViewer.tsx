import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { ArtifactRef } from "../../types";
import { getArtifactContent } from "../../lib/api";

interface DiffViewerProps {
  pipelineId: string;
  diffs: ArtifactRef[];
}

interface DiffItemProps {
  pipelineId: string;
  artifact: ArtifactRef;
}

function DiffItem({ pipelineId, artifact }: DiffItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && !content && !loading) {
      setLoading(true);
      getArtifactContent(pipelineId, artifact.id)
        .then(setContent)
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }
  }, [expanded, content, loading, pipelineId, artifact.id]);

  // Parse diff content for rendering
  const renderDiffContent = (diffText: string) => {
    const lines = diffText.split("\n");
    let currentFile = "";

    return lines.map((line, i) => {
      // File header
      if (line.startsWith("diff --git")) {
        const match = line.match(/diff --git a\/(.*) b\//);
        currentFile = match ? match[1] : "";
        return (
          <div
            key={i}
            className="bg-gray-200 text-gray-800 px-2 py-1 font-medium text-xs mt-2 first:mt-0"
          >
            {currentFile || line}
          </div>
        );
      }

      // Skip other header lines
      if (
        line.startsWith("index ") ||
        line.startsWith("---") ||
        line.startsWith("+++")
      ) {
        return null;
      }

      // Hunk header
      if (line.startsWith("@@")) {
        return (
          <div
            key={i}
            className="bg-blue-50 text-blue-700 px-2 py-0.5 text-xs font-mono"
          >
            {line}
          </div>
        );
      }

      // Addition
      if (line.startsWith("+")) {
        return (
          <div
            key={i}
            className="bg-green-50 text-green-800 px-2 font-mono text-xs whitespace-pre"
          >
            <span className="text-green-600 select-none mr-2">+</span>
            {line.slice(1)}
          </div>
        );
      }

      // Deletion
      if (line.startsWith("-")) {
        return (
          <div
            key={i}
            className="bg-red-50 text-red-800 px-2 font-mono text-xs whitespace-pre"
          >
            <span className="text-red-600 select-none mr-2">-</span>
            {line.slice(1)}
          </div>
        );
      }

      // Context line
      if (line.startsWith(" ") || line === "") {
        return (
          <div
            key={i}
            className="bg-gray-50 text-gray-700 px-2 font-mono text-xs whitespace-pre"
          >
            <span className="text-gray-400 select-none mr-2"> </span>
            {line.slice(1) || " "}
          </div>
        );
      }

      // Other lines
      return (
        <div
          key={i}
          className="bg-gray-50 text-gray-600 px-2 font-mono text-xs whitespace-pre"
        >
          {line}
        </div>
      );
    });
  };

  // Count additions and deletions
  const countChanges = (diffText: string) => {
    const lines = diffText.split("\n");
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    return { additions, deletions };
  };

  const changes = content ? countChanges(content) : null;

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
            className={cn("transition-transform", expanded && "rotate-90")}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>

          <span className="font-medium">
            {artifact.requirementId || "Code Changes"}
          </span>

          {changes && (
            <span className="text-xs">
              <span className="text-green-600">+{changes.additions}</span>
              {" / "}
              <span className="text-red-600">-{changes.deletions}</span>
            </span>
          )}
        </div>

        <span className="text-xs text-gray-500">
          {new Date(artifact.createdAt).toLocaleTimeString()}
        </span>
      </button>

      {expanded && (
        <div className="border-t max-h-96 overflow-auto">
          {loading && (
            <div className="p-3 text-gray-500 text-xs">Loading...</div>
          )}

          {error && (
            <div className="p-3 text-red-500 text-xs">Error: {error}</div>
          )}

          {content && (
            <div className="text-xs">{renderDiffContent(content)}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function DiffViewer({ pipelineId, diffs }: DiffViewerProps) {
  if (diffs.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {diffs.map((diff) => (
        <DiffItem key={diff.id} pipelineId={pipelineId} artifact={diff} />
      ))}
    </div>
  );
}
