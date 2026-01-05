/**
 * Pipeline session model for multi-step agent orchestration.
 * Manages the full workflow: QA → Plan → Execute → Test loop.
 * In-memory store with pub/sub for SSE streaming.
 * Persists state to JSON for recovery across restarts.
 */

import { loadFromFile, saveToFile, clearFile } from "./persistence";

export type PipelinePhase = "qa" | "exploring" | "planning" | "executing" | "testing";

export type PipelineStatus =
  | "qa"
  | "exploring"
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
  | "exploring_started"
  | "exploring_completed"
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
  // Project setup
  | "target_project_set"
  // Progress
  | "requirement_started"
  | "requirement_completed"
  | "requirement_failed"
  // Tests
  | "test_passed"
  | "test_failed"
  | "screenshot_captured"
  // Server management
  | "server_starting"
  | "server_healthy"
  | "server_error"
  | "server_warning"
  | "servers_ready"
  | "servers_stopped"
  // Control
  | "retry_started"
  | "paused"
  | "resumed"
  | "aborted"
  // Terminal
  | "pipeline_completed"
  | "pipeline_failed"
  // Tool activity (for verbose logging)
  | "tool_started"
  | "tool_completed"
  | "tool_error"
  | "status_update"
  // Todo updates from agent
  | "todo_update"
  // Parallel exploration
  | "parallel_exploration_started"
  | "parallel_exploration_completed"
  | "explorer_started"
  | "explorer_completed"
  | "explorer_error"
  | "model_selected";

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

export interface EpicProgress {
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
}

export interface Epic {
  id: string;
  title: string;
  goal: string;
  priority: number;
  definitionOfDone: string;
  keyScreens: string[];
  smokeTestIds: string[];
  requirementIds: string[];
  status: "pending" | "in_progress" | "completed" | "partial";
  progress: EpicProgress;
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
  epics: Epic[];
  currentRunId?: string;
  artifacts: ArtifactRef[];
  events: PipelineEvent[];
  // Control flags
  pauseRequested: boolean;
  abortRequested: boolean;
  // Conversation history for QA phase
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  // Target project path (where generated code goes)
  targetProjectPath?: string;
}

type EventSubscriber = (event: PipelineEvent) => void;

const PIPELINES_FILE = "pipelines.json";

// Persisted state structure
interface PersistedState {
  pipelines: Array<[string, Pipeline]>;
  activePipelineId: string | null;
}

// In-memory stores
const pipelines = new Map<string, Pipeline>();
const subscribers = new Map<string, Set<EventSubscriber>>();

// Global lock for single-pipeline mode (V1)
let activePipelineId: string | null = null;

// In-memory only (not persisted) - tracks if loop is actually running
// After server restart this is empty, correctly indicating no pipelines are running
const runningPipelines = new Set<string>();

/**
 * Mark a pipeline as actively running (loop is executing)
 */
export function markRunning(pipelineId: string): void {
  runningPipelines.add(pipelineId);
}

/**
 * Mark a pipeline as stopped (loop finished or crashed)
 */
export function markStopped(pipelineId: string): void {
  runningPipelines.delete(pipelineId);
}

/**
 * Check if a pipeline's loop is actively running
 */
export function isRunning(pipelineId: string): boolean {
  return runningPipelines.has(pipelineId);
}

/**
 * Save current state to disk
 */
function persistState(): void {
  const state: PersistedState = {
    pipelines: Array.from(pipelines.entries()),
    activePipelineId,
  };
  saveToFile(PIPELINES_FILE, state);
}

/**
 * Load state from disk on startup
 */
function loadPersistedState(): void {
  const state = loadFromFile<PersistedState>(PIPELINES_FILE);
  if (state) {
    pipelines.clear();
    for (const [id, pipeline] of state.pipelines) {
      pipelines.set(id, pipeline);
      subscribers.set(id, new Set());
    }
    activePipelineId = state.activePipelineId;
    console.log(`Loaded ${pipelines.size} pipeline(s) from disk`);
  }
}

// Load persisted state on module initialization
loadPersistedState();

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
export function createPipeline(
  initialPrompt: string,
  targetProjectPath?: string
): Pipeline | null {
  // V1: Only allow one pipeline at a time
  if (activePipelineId !== null) {
    console.log(`[Pipeline] Cannot create pipeline - one already active: ${activePipelineId}`);
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
    epics: [],
    artifacts: [],
    events: [],
    pauseRequested: false,
    abortRequested: false,
    conversationHistory: [],
    targetProjectPath,
  };

  pipelines.set(id, pipeline);
  subscribers.set(id, new Set());
  activePipelineId = id;

  console.log(`[Pipeline] Created pipeline ${id}`);
  persistState();
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

  const oldPhase = pipeline.phase.current;
  pipeline.phase = { ...pipeline.phase, ...updates };

  // Update status based on phase
  if (updates.current && !pipeline.pauseRequested && !pipeline.abortRequested) {
    pipeline.status = updates.current;
  }

  if (updates.current && updates.current !== oldPhase) {
    console.log(`[Pipeline] ${pipelineId.slice(0, 8)} phase: ${oldPhase} → ${updates.current}`);
  }

  persistState();
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

  const oldStatus = pipeline.status;
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

  if (status !== oldStatus) {
    console.log(`[Pipeline] ${pipelineId.slice(0, 8)} status: ${oldStatus} → ${status}`);
  }

  persistState();
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

  persistState();
}

/**
 * Set epics after QA phase completes
 */
export function setEpics(pipelineId: string, epics: Epic[]): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  pipeline.epics = epics;
  persistState();
}

/**
 * Update epic progress based on current requirement statuses
 */
export function updateEpicProgress(pipelineId: string): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  for (const epic of pipeline.epics) {
    const linkedReqs = pipeline.requirements.filter((r) =>
      epic.requirementIds.includes(r.id)
    );

    const completed = linkedReqs.filter((r) => r.status === "completed").length;
    const failed = linkedReqs.filter((r) => r.status === "failed").length;
    const inProgress = linkedReqs.filter(
      (r) => r.status === "in_progress"
    ).length;

    epic.progress = {
      total: linkedReqs.length,
      completed,
      failed,
      inProgress,
    };

    // Compute epic status
    if (completed === epic.progress.total && epic.progress.total > 0) {
      epic.status = "completed";
    } else if (inProgress > 0) {
      epic.status = "in_progress";
    } else if (completed > 0 || failed > 0) {
      epic.status = "partial";
    } else {
      epic.status = "pending";
    }
  }

  persistState();
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
    persistState();
  }
}

/**
 * Set the target project path (where generated code will be written)
 */
export function setTargetProjectPath(
  pipelineId: string,
  targetPath: string
): void {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return;

  pipeline.targetProjectPath = targetPath;
  persistState();
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
  persistState();
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
  persistState();
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
  persistState();
}

/**
 * Request pause at next checkpoint
 */
export function requestPause(pipelineId: string): boolean {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return false;

  console.log(`[Pipeline] ${pipelineId.slice(0, 8)} pause requested`);
  pipeline.pauseRequested = true;
  persistState();
  return true;
}

/**
 * Request abort - immediately marks pipeline as aborted and clears active state
 */
export function requestAbort(pipelineId: string): boolean {
  const pipeline = pipelines.get(pipelineId);
  if (!pipeline) return false;

  console.log(`[Pipeline] ${pipelineId.slice(0, 8)} abort requested`);
  pipeline.abortRequested = true;
  // Immediately update status to aborted (this also clears activePipelineId)
  updateStatus(pipelineId, "aborted");
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
  persistState();
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
  persistState();

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
  clearFile(PIPELINES_FILE);
}

/**
 * Get all pipelines (for listing)
 */
export function getAllPipelines(): Pipeline[] {
  return Array.from(pipelines.values());
}
