import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.restore();

type PipelineStub = {
  phase: { current: string };
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  targetProjectPath?: string;
  isNewProject?: boolean;
  qa?: { stage?: string; featureId?: string; featurePrefix?: string };
  claudeStorageId?: string;
};

let pipeline: PipelineStub | undefined;

const getPipeline = jest.fn(() => pipeline);
const updatePhase = jest.fn();
const updateStatus = jest.fn();
const setRequirements = jest.fn();
const setEpics = jest.fn();
const setTargetProjectPath = jest.fn();
const setIsNewProject = jest.fn();
const setFeaturePrefix = jest.fn();
const setClaudeStorageId = jest.fn();
const setSessionId = jest.fn();
const clearSessionId = jest.fn();
const getSessionId = jest.fn(() => undefined);
const updateQAState = jest.fn();
const markRunning = jest.fn();
const markStopped = jest.fn();
const appendEvent = jest.fn();
const addToConversation = jest.fn((_, role, content) => {
  pipeline?.conversationHistory.push({ role, content });
});

const createToolCallbacks = jest.fn(() => ({}));
const emitTodoEvents = jest.fn();
const logPhase = jest.fn();
const LOG = { qa: "[QA]" };

const sessionSend = jest.fn();
const createV2Session = jest.fn(async () => ({
  systemPrompt: "prompt",
  send: sessionSend,
  close: jest.fn(),
}));
const resumeV2Session = jest.fn(async () => ({
  systemPrompt: "prompt",
  send: sessionSend,
  close: jest.fn(),
}));

const runHarness = jest.fn(async () => {});
const generateClaudeStorageId = jest.fn(() => "storage-id");

const loadFeatureMap = jest.fn(async () => null);
const getPendingFeatures = jest.fn(() => []);
const getFeatureSpecPath = jest.fn(
  () => "/fake/root/.claude/feature/feature-spec.v3.json"
);
const selectPrimaryFeature = jest.fn(() => null);
const getFeatureMapPath = jest.fn(
  () => "/fake/root/.claude/feature-map/feature-map.json"
);

let parsedRequirements: Array<Record<string, unknown>> = [];
let parsedEpics: Array<Record<string, unknown>> = [];
let parsedProjectName = "Project";
let parsedFeaturePrefix = "weather";
const parseRequirementsFromSpec = jest.fn(async () => ({
  requirements: parsedRequirements,
  epics: parsedEpics,
  projectName: parsedProjectName,
  featurePrefix: parsedFeaturePrefix,
}));
const generateTargetProjectPath = jest.fn(() => "/target/path");
const generateStagingProjectPath = jest.fn(() => "/staging/path");
const initializeTargetProject = jest.fn(async () => {});
const sanitizeProjectName = jest.fn((name: string) =>
  name.toLowerCase().replace(/\s+/g, "-")
);
const FLIGHTPATH_ROOT = "/fake/root";
const CLAUDE_STORAGE_ROOT = "/fake/root/.claude";

let specExists = false;

mock.module("node:fs", () => ({
  existsSync: () => specExists,
  unlinkSync: jest.fn(),
  readdirSync: jest.fn(() => []),
}));
mock.module("../pipeline", () => ({
  getPipeline,
  updatePhase,
  updateStatus,
  setRequirements,
  setEpics,
  setTargetProjectPath,
  setFeaturePrefix,
  setIsNewProject,
  setClaudeStorageId,
  setSessionId,
  clearSessionId,
  getSessionId,
  updateQAState,
  addToConversation,
  appendEvent,
  markRunning,
  markStopped,
}));
mock.module("../claude-paths", () => ({
  CLAUDE_STORAGE_ROOT,
  generateClaudeStorageId,
}));
mock.module("../session", () => ({
  createV2Session,
  resumeV2Session,
}));
mock.module("./callbacks", () => ({
  createToolCallbacks,
  emitTodoEvents,
}));
mock.module("./utils", () => ({
  LOG,
  logPhase,
}));
mock.module("./project-init", () => ({
  FLIGHTPATH_ROOT,
  parseRequirementsFromSpec,
  generateTargetProjectPath,
  generateStagingProjectPath,
  initializeTargetProject,
  sanitizeProjectName,
}));
mock.module("./feature-map", () => ({
  loadFeatureMap,
  getPendingFeatures,
  getFeatureSpecPath,
  selectPrimaryFeature,
  getFeatureMapPath,
}));
mock.module("../harness", () => ({
  runHarness,
}));

const { runQAPhase, handleUserMessage } = await import(
  `./qa-phase?test=${Date.now()}`
);

beforeEach(() => {
  jest.clearAllMocks();
  pipeline = {
    phase: { current: "qa" },
    conversationHistory: [],
    targetProjectPath: "/project/path",
    isNewProject: false,
    qa: { stage: "map" },
  };
  parsedRequirements = [];
  parsedEpics = [];
  parsedProjectName = "Project";
  parsedFeaturePrefix = "weather";
  specExists = false;
  sessionSend.mockResolvedValue({
    reply: "ok",
    requiresUserInput: true,
    toolCalls: [],
    userQuestions: [],
  });
});

describe("runQAPhase", () => {
  it("returns early when pipeline missing", async () => {
    pipeline = undefined;

    await runQAPhase("pipe-1", "hello");
    expect(createV2Session).not.toHaveBeenCalled();
  });

  it("waits for user input when required", async () => {
    sessionSend.mockResolvedValue({
      reply: "Question",
      requiresUserInput: true,
      toolCalls: [],
      userQuestions: [],
    });

    await runQAPhase("pipe-1", "hello");

    expect(parseRequirementsFromSpec).not.toHaveBeenCalled();
    expect(initializeTargetProject).not.toHaveBeenCalled();

    const types = appendEvent.mock.calls.map((call) => call[1]);
    expect(types).toContain("qa_started");
    expect(types).toContain("agent_message");
  });

  it("completes QA and starts harness", async () => {
    // Set specExists to true so runSpecGeneration finds the understanding file
    specExists = true;

    sessionSend.mockResolvedValue({
      reply: "done",
      requiresUserInput: false,
      toolCalls: [
        {
          name: "Write",
          args: { file_path: "/fake/root/.claude/feature-understanding.json" },
        },
      ],
    });

    parsedRequirements = [
      {
        id: "req-1",
        title: "Title",
        description: "Desc",
        priority: 1,
        status: "pending",
        acceptanceCriteria: [],
      },
    ];

    await runQAPhase("pipe-1", "hello");

    expect(parseRequirementsFromSpec).toHaveBeenCalledWith("/fake/root", undefined);
    expect(setFeaturePrefix).toHaveBeenCalled();
    expect(setTargetProjectPath).toHaveBeenCalledWith("pipe-1", "/project/path");
    expect(initializeTargetProject).toHaveBeenCalledWith(
      "/project/path",
      "storage-id",
      parsedFeaturePrefix,
      "/fake/root",
      true
    );
    expect(setRequirements).toHaveBeenCalled();
    expect(setEpics).toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith("pipe-1", { totalRequirements: 1 });
    expect(runHarness).toHaveBeenCalled();

    const types = appendEvent.mock.calls.map((call) => call[1]);
    expect(types).toContain("qa_completed");
    expect(types).toContain("target_project_set");
  });

  it("fails when no requirements found", async () => {
    sessionSend.mockResolvedValue({
      reply: "done",
      requiresUserInput: false,
      toolCalls: [
        {
          name: "Write",
          args: { file_path: "/fake/root/.claude/feature-understanding.json" },
        },
      ],
    });

    parsedRequirements = [];

    await runQAPhase("pipe-1", "hello");

    expect(updateStatus).toHaveBeenCalledWith("pipe-1", "failed");
    expect(initializeTargetProject).not.toHaveBeenCalled();
  });
});

describe("handleUserMessage", () => {
  it("rejects messages outside QA phase", async () => {
    if (pipeline) pipeline.phase.current = "planning";

    await handleUserMessage("pipe-1", "message");

    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "user_message",
      expect.objectContaining({ error: "User messages only allowed during QA phase" })
    );
  });

  it("continues QA and emits events", async () => {
    sessionSend.mockResolvedValue({
      reply: "next",
      requiresUserInput: true,
      toolCalls: [],
      userQuestions: [],
    });

    await handleUserMessage("pipe-1", "message");

    const types = appendEvent.mock.calls.map((call) => call[1]);
    expect(types).toContain("user_message");
    expect(types).toContain("status_update");
    expect(types).toContain("agent_message");
  });
});
