import { cn } from "@/lib/utils";
import type { Run } from "../types";

interface RunListProps {
  runs: Run[];
  selectedId?: string;
  onSelect: (runId: string) => void;
}

const statusColors: Record<Run["status"], string> = {
  queued: "bg-gray-400",
  running: "bg-yellow-400 animate-pulse",
  succeeded: "bg-green-500",
  failed: "bg-red-500",
};

export function RunList({ runs, selectedId, onSelect }: RunListProps) {
  if (runs.length === 0) {
    return (
      <div className="p-4 text-gray-500 text-sm">
        No runs yet. Enter a message to start.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {runs.map((run) => (
        <button
          key={run.id}
          onClick={() => onSelect(run.id)}
          className={cn(
            "flex items-center gap-3 p-3 text-left border-b border-gray-100 hover:bg-gray-50 transition-colors",
            selectedId === run.id && "bg-blue-50"
          )}
        >
          <span
            className={cn("w-2 h-2 rounded-full", statusColors[run.status])}
          />
          <div className="flex-1 min-w-0">
            <div className="truncate text-sm font-medium text-gray-900">
              {run.input.message}
            </div>
            <div className="text-xs text-gray-500">
              {new Date(run.createdAt).toLocaleTimeString()}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
