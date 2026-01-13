import type {
  Pipeline,
  PipelineEvent,
  PipelineSummary,
  ArtifactRef,
  FlowAnalysisResult,
} from "../types";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8787";

// ============================================
// Pipeline API
// ============================================

export class PipelineConflictError extends Error {
  constructor(public activePipelineId: string) {
    super("A pipeline is already active");
    this.name = "PipelineConflictError";
  }
}

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
    // Handle 409 conflict with active pipeline
    if (response.status === 409 && error.activePipelineId) {
      throw new PipelineConflictError(error.activePipelineId);
    }
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

/**
 * Resume an orphaned pipeline (e.g., after server restart)
 * Unlike resume, this works for any non-terminal, non-running pipeline
 */
export async function goPipeline(pipelineId: string): Promise<void> {
  const response = await fetch(
    `${BACKEND_URL}/api/pipelines/${pipelineId}/go`,
    { method: "POST" }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to go pipeline");
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

/**
 * Fetch artifact content as text (for diffs, test results)
 */
export async function getArtifactContent(
  pipelineId: string,
  artifactId: string
): Promise<string> {
  const response = await fetch(getArtifactUrl(pipelineId, artifactId));

  if (!response.ok) {
    throw new Error("Failed to fetch artifact content");
  }

  return response.text();
}

/**
 * Fetch artifact content as JSON
 */
export async function getArtifactJson<T = unknown>(
  pipelineId: string,
  artifactId: string
): Promise<T> {
  const response = await fetch(getArtifactUrl(pipelineId, artifactId));

  if (!response.ok) {
    throw new Error("Failed to fetch artifact content");
  }

  return response.json();
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

// ============================================
// Flow Analysis API
// ============================================

export async function analyzeFlow(
  pipelineId: string
): Promise<FlowAnalysisResult> {
  const response = await fetch(
    `${BACKEND_URL}/api/pipelines/${pipelineId}/analyze`,
    { method: "POST" }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || "Failed to analyze flow");
  }

  return response.json();
}
