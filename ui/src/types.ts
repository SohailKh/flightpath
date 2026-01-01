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
  pauseRequested: boolean;
  abortRequested: boolean;
  conversationHistory: ConversationMessage[];
}

export interface PipelineSummary {
  id: string;
  status: PipelineStatus;
  createdAt: string;
  phase: PhaseState;
  requirementsCount: number;
}
