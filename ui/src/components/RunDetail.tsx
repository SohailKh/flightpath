import { cn } from "@/lib/utils";
import type { Run, RunEvent } from "../types";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

interface RunDetailProps {
  run: Run;
  events: RunEvent[];
}

const eventTypeLabels: Record<RunEvent["type"], string> = {
  received: "Received",
  calling_agent: "Calling Agent",
  agent_reply: "Agent Reply",
  completed: "Completed",
  failed: "Failed",
};

const eventTypeColors: Record<RunEvent["type"], string> = {
  received: "text-blue-600",
  calling_agent: "text-yellow-600",
  agent_reply: "text-green-600",
  completed: "text-green-700",
  failed: "text-red-600",
};

export function RunDetail({ run, events }: RunDetailProps) {
  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Status header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">
            {run.input.message}
          </h2>
          <p className="text-sm text-gray-500">
            {new Date(run.createdAt).toLocaleString()}
          </p>
        </div>
        <StatusBadge status={run.status} />
      </div>

      {/* Events feed */}
      <Card className="flex-1 overflow-hidden flex flex-col">
        <CardHeader className="py-3">
          <CardTitle className="text-sm">Events</CardTitle>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto">
          <div className="space-y-2">
            {events.map((event, i) => (
              <div
                key={i}
                className="flex gap-3 text-sm py-2 border-b border-gray-100 last:border-0"
              >
                <span className="text-gray-400 text-xs font-mono w-20 flex-shrink-0">
                  {new Date(event.ts).toLocaleTimeString()}
                </span>
                <span
                  className={cn(
                    "font-medium w-28 flex-shrink-0",
                    eventTypeColors[event.type]
                  )}
                >
                  {eventTypeLabels[event.type]}
                </span>
                <span className="text-gray-600 flex-1 truncate">
                  {formatEventData(event)}
                </span>
              </div>
            ))}
            {events.length === 0 && (
              <div className="text-gray-400 text-sm">Waiting for events...</div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Final output */}
      {run.output && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm text-green-700">Reply</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-800 whitespace-pre-wrap">
              {run.output.reply}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Error output */}
      {run.error && (
        <Card className="border-red-200 bg-red-50">
          <CardHeader className="py-3">
            <CardTitle className="text-sm text-red-700">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-800">{run.error.message}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: Run["status"] }) {
  const colors: Record<Run["status"], string> = {
    queued: "bg-gray-100 text-gray-700",
    running: "bg-yellow-100 text-yellow-700",
    succeeded: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
  };

  return (
    <span
      className={cn(
        "px-2 py-1 rounded-full text-xs font-medium",
        colors[status]
      )}
    >
      {status}
    </span>
  );
}

function formatEventData(event: RunEvent): string {
  if (event.type === "received" && "message" in event.data) {
    return String(event.data.message);
  }
  if (event.type === "agent_reply" && "reply" in event.data) {
    const reply = String(event.data.reply);
    return reply.length > 50 ? reply.slice(0, 50) + "..." : reply;
  }
  if (event.type === "failed" && "error" in event.data) {
    return String(event.data.error);
  }
  return "";
}
