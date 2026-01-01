/**
 * Run session model for observing agent executions.
 * In-memory store with pub/sub for SSE streaming.
 */

export type RunEventType =
  | "received"
  | "calling_agent"
  | "agent_reply"
  | "completed"
  | "failed";

export interface RunEvent {
  ts: string;
  type: RunEventType;
  data: Record<string, unknown>;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface Run {
  id: string;
  createdAt: string;
  status: RunStatus;
  input: { message: string };
  output?: { reply: string };
  error?: { message: string };
  events: RunEvent[];
}

type EventSubscriber = (event: RunEvent) => void;

// In-memory stores
const runs = new Map<string, Run>();
const subscribers = new Map<string, Set<EventSubscriber>>();

/**
 * Create a new run in "queued" status
 */
export function createRun(message: string): Run {
  const id = crypto.randomUUID();
  const run: Run = {
    id,
    createdAt: new Date().toISOString(),
    status: "queued",
    input: { message },
    events: [],
  };
  runs.set(id, run);
  subscribers.set(id, new Set());
  return run;
}

/**
 * Get a run by ID
 */
export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

/**
 * Append an event to a run and notify all subscribers.
 * Silently returns if run doesn't exist (may have been cleared).
 */
export function appendEvent(
  runId: string,
  type: RunEventType,
  data: Record<string, unknown> = {}
): void {
  const run = runs.get(runId);
  if (!run) {
    return; // Run may have been cleared (e.g., by tests)
  }

  const event: RunEvent = {
    ts: new Date().toISOString(),
    type,
    data,
  };

  run.events.push(event);

  // Update status based on event type
  if (type === "received" || type === "calling_agent") {
    run.status = "running";
  } else if (type === "completed") {
    run.status = "succeeded";
  } else if (type === "failed") {
    run.status = "failed";
  }

  // Notify all subscribers
  const runSubscribers = subscribers.get(runId);
  if (runSubscribers) {
    for (const callback of runSubscribers) {
      try {
        callback(event);
      } catch (err) {
        console.error("Subscriber callback error:", err);
      }
    }
  }
}

/**
 * Set the output of a run.
 * Silently returns if run doesn't exist (may have been cleared).
 */
export function setOutput(runId: string, reply: string): void {
  const run = runs.get(runId);
  if (!run) {
    return; // Run may have been cleared (e.g., by tests)
  }
  run.output = { reply };
}

/**
 * Set the error of a run.
 * Silently returns if run doesn't exist (may have been cleared).
 */
export function setError(runId: string, message: string): void {
  const run = runs.get(runId);
  if (!run) {
    return; // Run may have been cleared (e.g., by tests)
  }
  run.error = { message };
}

/**
 * Subscribe to events for a run.
 * Returns an unsubscribe function.
 */
export function subscribe(
  runId: string,
  callback: EventSubscriber
): () => void {
  let runSubscribers = subscribers.get(runId);
  if (!runSubscribers) {
    runSubscribers = new Set();
    subscribers.set(runId, runSubscribers);
  }

  runSubscribers.add(callback);

  // Return unsubscribe function
  return () => {
    runSubscribers?.delete(callback);
  };
}

/**
 * Check if a run is in a terminal state (succeeded or failed)
 */
export function isTerminal(runId: string): boolean {
  const run = runs.get(runId);
  return run?.status === "succeeded" || run?.status === "failed";
}

/**
 * Clear all runs (useful for testing)
 */
export function clearRuns(): void {
  runs.clear();
  subscribers.clear();
}
