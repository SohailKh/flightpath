// ============================================
// Run Types (existing)
// ============================================

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

// ============================================
// Pipeline Types
// ============================================

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

// Tool event data for tool_started/tool_completed/tool_error events
export interface ToolEventData {
  toolName: string;
  toolUseId: string;
  args?: unknown;
  durationMs?: number;
  result?: string;
  error?: string;
  phase?: PipelinePhase;
  outcome?: "success" | "warning";
}

// Status update data for status_update events
export interface StatusUpdateData {
  action: string;
  phase: PipelinePhase;
}

// Todo item from SDK structured output
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

// Todo event data for todo_update events
export interface TodoEventData {
  todos: TodoItem[];
  phase: PipelinePhase;
}

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
  size: number;
  createdAt: string;
  requirementId?: string;
}

export interface PhaseState {
  current: PipelinePhase;
  requirementIndex: number;
  totalRequirements: number;
  retryCount: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

// ============================================
// AskUserQuestion Types
// ============================================

export interface QuestionOption {
  label: string;
  description: string;
}

export interface AskUserQuestion {
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
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
  pauseRequested: boolean;
  abortRequested: boolean;
  conversationHistory: ConversationMessage[];
  /** Whether the pipeline loop is actively running (not persisted - false after server restart) */
  isRunning?: boolean;
}

export interface PipelineSummary {
  id: string;
  status: PipelineStatus;
  createdAt: string;
  phase: PhaseState;
  requirementsCount: number;
}

// ============================================
// Flow Analysis Types
// ============================================

export interface AnalysisMetadata {
  analyzedAt: string;
  pipelineId: string;
  toolCallCount: number;
  errorCount: number;
  retryCount: number;
  duration: string;
  phases: string[];
}

export interface FlowAnalysisResult {
  suggestions: string;
  claudeCodePrompt: string;
  contextData: string;
  metadata: AnalysisMetadata;
}

// ============================================
// Parallel Exploration Types
// ============================================

export type ExplorerType = "pattern" | "api" | "test";
export type ExplorationDepth = "quick" | "medium" | "thorough";

export interface ExplorerProgress {
  type: ExplorerType;
  status: "pending" | "running" | "completed" | "error";
  duration?: number;
  patternsFound?: number;
  filesFound?: number;
  error?: string;
}

export interface ParallelExplorationState {
  requirementId: string;
  depth: ExplorationDepth;
  explorers: ExplorerProgress[];
  selectedModel?: string;
  complexityScore?: number;
  totalDuration?: number;
}

export interface ModelSelectionData {
  requirementId: string;
  selectedModel: string;
  complexityScore: number;
  depth: ExplorationDepth;
  successfulExplorers: number;
  failedExplorers: number;
}
