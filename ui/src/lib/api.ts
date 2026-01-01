import type {
  Run,
  RunEvent,
  Pipeline,
  PipelineEvent,
  PipelineSummary,
  ArtifactRef,
} from "../types";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8787";

export async function createRun(message: string): Promise<{ runId: string }> {
  const response = await fetch(`${BACKEND_URL}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to create run");
  }

  return response.json();
}

export async function getRun(runId: string): Promise<Run> {
  const response = await fetch(`${BACKEND_URL}/api/runs/${runId}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to get run");
  }

  return response.json();
}

export interface EventStreamCallbacks {
  onEvent: (event: RunEvent) => void;
  onDone: (status: string) => void;
  onError: (error: Error) => void;
}

export function subscribeToRunEvents(
  runId: string,
  callbacks: EventStreamCallbacks
): () => void {
  const eventSource = new EventSource(`${BACKEND_URL}/api/runs/${runId}/events`);

  eventSource.addEventListener("run_event", (e) => {
    try {
      const event = JSON.parse(e.data) as RunEvent;
      callbacks.onEvent(event);
    } catch (err) {
      console.error("Failed to parse run_event:", err);
    }
  });

  eventSource.addEventListener("done", (e) => {
    try {
      const data = JSON.parse(e.data);
      callbacks.onDone(data.status);
    } catch (err) {
      console.error("Failed to parse done event:", err);
    }
    eventSource.close();
  });

  eventSource.onerror = (err) => {
    console.error("EventSource error:", err);
    callbacks.onError(new Error("Connection error"));
    eventSource.close();
  };

  // Return cleanup function
  return () => {
    eventSource.close();
  };
}

// ============================================
// Pipeline API
// ============================================

export async function createPipeline(
  initialPrompt: string
): Promise<{ pipelineId: string }> {
  const response = await fetch(`${BACKEND_URL}/api/pipelines`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initialPrompt }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to create pipeline");
  }

  return response.json();
}

export async function getPipelines(): Promise<{
  pipelines: PipelineSummary[];
  activePipelineId: string | null;
}> {
  const response = await fetch(`${BACKEND_URL}/api/pipelines`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to get pipelines");
  }

  return response.json();
}

export async function getPipeline(pipelineId: string): Promise<Pipeline> {
  const response = await fetch(`${BACKEND_URL}/api/pipelines/${pipelineId}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to get pipeline");
  }

  return response.json();
}

export async function sendPipelineMessage(
  pipelineId: string,
  message: string
): Promise<void> {
  const response = await fetch(
    `${BACKEND_URL}/api/pipelines/${pipelineId}/message`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to send message");
  }
}

export async function pausePipeline(pipelineId: string): Promise<void> {
  const response = await fetch(
    `${BACKEND_URL}/api/pipelines/${pipelineId}/pause`,
    { method: "POST" }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to pause pipeline");
  }
}

export async function abortPipeline(pipelineId: string): Promise<void> {
  const response = await fetch(
    `${BACKEND_URL}/api/pipelines/${pipelineId}/abort`,
    { method: "POST" }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to abort pipeline");
  }
}

export async function resumePipeline(pipelineId: string): Promise<void> {
  const response = await fetch(
    `${BACKEND_URL}/api/pipelines/${pipelineId}/resume`,
    { method: "POST" }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to resume pipeline");
  }
}

export async function getPipelineArtifacts(
  pipelineId: string
): Promise<{ artifacts: ArtifactRef[] }> {
  const response = await fetch(
    `${BACKEND_URL}/api/pipelines/${pipelineId}/artifacts`
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to get artifacts");
  }

  return response.json();
}

export function getArtifactUrl(pipelineId: string, artifactId: string): string {
  return `${BACKEND_URL}/api/pipelines/${pipelineId}/artifacts/${artifactId}`;
}

export interface PipelineEventStreamCallbacks {
  onEvent: (event: PipelineEvent) => void;
  onDone: (status: string) => void;
  onError: (error: Error) => void;
}

export function subscribeToPipelineEvents(
  pipelineId: string,
  callbacks: PipelineEventStreamCallbacks
): () => void {
  const eventSource = new EventSource(
    `${BACKEND_URL}/api/pipelines/${pipelineId}/events`
  );

  eventSource.addEventListener("pipeline_event", (e) => {
    try {
      const event = JSON.parse(e.data) as PipelineEvent;
      callbacks.onEvent(event);
    } catch (err) {
      console.error("Failed to parse pipeline_event:", err);
    }
  });

  eventSource.addEventListener("done", (e) => {
    try {
      const data = JSON.parse(e.data);
      callbacks.onDone(data.status);
    } catch (err) {
      console.error("Failed to parse done event:", err);
    }
    eventSource.close();
  });

  eventSource.onerror = (err) => {
    console.error("EventSource error:", err);
    callbacks.onError(new Error("Connection error"));
    eventSource.close();
  };

  return () => {
    eventSource.close();
  };
}
