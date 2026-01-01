/**
 * Pipeline session model for multi-step agent orchestration.
 * Manages the full workflow: QA → Plan → Execute → Test loop.
 * In-memory store with pub/sub for SSE streaming.
 */

export type PipelinePhase = "qa" | "planning" | "executing" | "testing";

export type PipelineStatus =
  | "qa"
  | "planning"
  | "executing"
  | "testing"
  | "paused"
  | "completed"
  | "failed"
  | "aborted";

export type PipelineEventType =
  // Phase transitions
  | "qa_started"
  | "qa_completed"
  | "planning_started"
  | "planning_completed"
  | "executing_started"
  | "executing_completed"
  | "testing_started"
  | "testing_completed"
  // QA conversation
  | "agent_message"
  | "user_message"
  | "requirements_ready"
  // Progress
  | "requirement_started"
  | "requirement_completed"
  | "requirement_failed"
  // Tests
  | "test_passed"
  | "test_failed"
  | "screenshot_captured"
  // Control
  | "retry_started"
  | "paused"
  | "resumed"
  | "aborted"
  // Terminal
  | "pipeline_completed"
  | "pipeline_failed";

export interface PipelineEvent {
  ts: string;
  type: PipelineEventType;
  data: Record<string, unknown>;
}

export interface Requirement {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: "pending" | "in_progress" | "completed" | "failed";
  acceptanceCriteria: string[];
}

export interface ArtifactRef {
  id: string;
  type: "screenshot" | "test_result" | "diff";
  path: string;
  requirementId?: string;
  createdAt: string;
}

export interface PhaseState {
  current: PipelinePhase;
  requirementIndex: number;
  totalRequirements: number;
  retryCount: number;
}

export interface Pipeline {
  id: string;
  createdAt: string;
  status: PipelineStatus;
  phase: PhaseState;
  input: { initialPrompt: string };
  requirements: Requirement[];
  currentRunId?: string;
  artifacts: ArtifactRef[];
  events: PipelineEvent[];
  // Control flags
  pauseRequested: boolean;
  abortRequested: boolean;
  // Conversation history for QA phase
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

type EventSubscriber = (event: PipelineEvent) => void;

// In-memory stores
const pipelines = new Map<string, Pipeline>();
const subscribers = new Map<string, Set<EventSubscriber>>();

// Global lock for single-pipeline mode (V1)
let activePipelineId: string | null = null;

/**
 * Check if a pipeline is currently active
 */
export function hasActivePipeline(): boolean {
  return activePipelineId !== null;
}

/**
 * Get the active pipeline ID
 */
export function getActivePipelineId(): string | null {
  return activePipelineId;
}

/**
 * Create a new pipeline in "qa" status
 */
export function createPipeline(initialPrompt: string): Pipeline | null {
  // V1: Only allow one pipeline at a time
  if (activePipelineId !== null) {
    return null;
  }

  const id = crypto.randomUUID();
  const pipeline: Pipeline = {
    id,
    createdAt: new Date().toISOString(),
    status: "qa",
    phase: {
      current: "qa",
      requirementIndex: 0,
      totalRequirements: 0,
      retryCount: 0,
    },
    input: { initialPrompt },
    requirements: [],
    artifacts: [],
    events: [],
    pauseRequested: false,
    abortRequested: false,
    conversationHistory: [],
  };

  pipelines.set(id, pipeline);
  subscribers.set(id, new Set());
  activePipelineId = id;

  return pipeline;
}

/**
 * Get a pipeline by ID
 */
export function getPipeline(id: string): Pipeline | undefined {
  return pipelines.get(id);
}

/**
 * Update pipeline phase state
 */
export function updatePhase(
  pipelineId: string,
  updates: Partial<PhaseState>
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  pipeline.phase = { ...pipeline.phase, ...updates };

  // Update status based on phase
  if (updates.current && !pipeline.pauseRequested && !pipeline.abortRequested) {
    pipeline.status = updates.current;
  }
}

/**
 * Update pipeline status
 */
export function updateStatus(
  pipelineId: string,
  status: PipelineStatus
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  pipeline.status = status;

  // Clear active pipeline if terminal state
  if (
    status === "completed" ||
    status === "failed" ||
    status === "aborted"
  ) {
    if (activePipelineId === pipelineId) {
      activePipelineId = null;
    }
  }
}

/**
 * Set requirements after QA phase completes
 */
export function setRequirements(
  pipelineId: string,
  requirements: Requirement[]
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  pipeline.requirements = requirements;
  pipeline.phase.totalRequirements = requirements.length;
}

/**
 * Update a specific requirement's status
 */
export function updateRequirement(
  pipelineId: string,
  requirementId: string,
  status: Requirement["status"]
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  const req = pipeline.requirements.find((r) => r.id === requirementId);
  if (req) {
    req.status = status;
  }
}

/**
 * Add to conversation history (for QA phase)
 */
export function addToConversation(
  pipelineId: string,
  role: "user" | "assistant",
  content: string
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  pipeline.conversationHistory.push({ role, content });
}

/**
 * Add an artifact reference
 */
export function addArtifact(
  pipelineId: string,
  artifact: Omit<ArtifactRef, "createdAt">
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  pipeline.artifacts.push({
    ...artifact,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Set the current run ID
 */
export function setCurrentRunId(
  pipelineId: string,
  runId: string | undefined
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  pipeline.currentRunId = runId;
}

/**
 * Request pause at next checkpoint
 */
export function requestPause(pipelineId: string): boolean {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return false;

  pipeline.pauseRequested = true;
  return true;
}

/**
 * Request abort
 */
export function requestAbort(pipelineId: string): boolean {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return false;

  pipeline.abortRequested = true;
  return true;
}

/**
 * Resume a paused pipeline
 */
export function resume(pipelineId: string): boolean {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline || pipeline.status !== "paused") return false;

  pipeline.pauseRequested = false;
  pipeline.status = pipeline.phase.current;
  return true;
}

/**
 * Check if pause was requested
 */
export function isPauseRequested(pipelineId: string): boolean {
  const pipeline = pipelines.get(pipelineId);
  return pipeline?.pauseRequested ?? false;
}

/**
 * Check if abort was requested
 */
export function isAbortRequested(pipelineId: string): boolean {
  const pipeline = pipelines.get(pipelineId);
  return pipeline?.abortRequested ?? false;
}

/**
 * Append an event to a pipeline and notify all subscribers
 */
export function appendEvent(
  pipelineId: string,
  type: PipelineEventType,
  data: Record<string, unknown> = {}
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  const event: PipelineEvent = {
    ts: new Date().toISOString(),
    type,
    data,
  };

  pipeline.events.push(event);

  // Notify all subscribers
  const pipelineSubscribers = subscribers.get(pipelineId);
  if (pipelineSubscribers) {
    for (const callback of pipelineSubscribers) {
      try {
        callback(event);
      } catch (err) {
        console.error("Pipeline subscriber callback error:", err);
      }
    }
  }
}

/**
 * Subscribe to events for a pipeline
 */
export function subscribe(
  pipelineId: string,
  callback: EventSubscriber
): () => void {
  let pipelineSubscribers = subscribers.get(pipelineId);
  if (!pipelineSubscribers) {
    pipelineSubscribers = new Set();
    subscribers.set(pipelineId, pipelineSubscribers);
  }

  pipelineSubscribers.add(callback);

  return () => {
    pipelineSubscribers?.delete(callback);
  };
}

/**
 * Check if a pipeline is in a terminal state
 */
export function isTerminal(pipelineId: string): boolean {
  const pipeline = pipelines.get(pipelineId);
  return (
    pipeline?.status === "completed" ||
    pipeline?.status === "failed" ||
    pipeline?.status === "aborted"
  );
}

/**
 * Clear all pipelines (useful for testing)
 */
export function clearPipelines(): void {
  pipelines.clear();
  subscribers.clear();
  activePipelineId = null;
}

/**
 * Get all pipelines (for listing)
 */
export function getAllPipelines(): Pipeline[] {
  return Array.from(pipelines.values());
}
