import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.restore();

let pipeline: {
  phase: { current: string };
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  targetProjectPath?: string;
} | undefined;

const getPipeline = jest.fn(() => pipeline);
const updatePhase = jest.fn();
const updateStatus = jest.fn();
const setRequirements = jest.fn();
const setEpics = jest.fn();
const setTargetProjectPath = jest.fn();
const setFeaturePrefix = jest.fn();
const appendEvent = jest.fn();
const addToConversation = jest.fn((_, role, content) => {
  pipeline?.conversationHistory.push({ role, content });
});

const runPipelineAgent = jest.fn();
const runPipelineAgentWithMessage = jest.fn();

const createToolCallbacks = jest.fn(() => ({}));
const logPhase = jest.fn();
const LOG = { qa: "[QA]" };

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
const initializeTargetProject = jest.fn(async () => {});
const FLIGHTPATH_ROOT = "/fake/root";

let specExists = false;

mock.module("node:fs", () => ({
  existsSync: () => specExists,
}));
mock.module("../pipeline", () => ({
  getPipeline,
  updatePhase,
  updateStatus,
  setRequirements,
  setEpics,
  setTargetProjectPath,
  setFeaturePrefix,
  addToConversation,
  appendEvent,
}));
mock.module("../agent", () => ({
  runPipelineAgent,
  runPipelineAgentWithMessage,
}));
mock.module("./callbacks", () => ({
  createToolCallbacks,
}));
mock.module("./utils", () => ({
  LOG,
  logPhase,
}));
mock.module("./project-init", () => ({
  FLIGHTPATH_ROOT,
  parseRequirementsFromSpec,
  generateTargetProjectPath,
  initializeTargetProject,
}));

const { runQAPhase, handleUserMessage, setImplementationLoopRunner } = await import(
  `./qa-phase?test=${Date.now()}`
);

beforeEach(() => {
  jest.clearAllMocks();
  pipeline = {
    phase: { current: "qa" },
    conversationHistory: [],
    targetProjectPath: "/project/path",
  };
  parsedRequirements = [];
  parsedEpics = [];
  parsedProjectName = "Project";
  parsedFeaturePrefix = "weather";
  specExists = false;
});

describe("runQAPhase", () => {
  it("returns early when pipeline missing", async () => {
    pipeline = undefined;

    await runQAPhase("pipe-1", "hello");
    expect(runPipelineAgent).not.toHaveBeenCalled();
  });

  it("waits for user input when required", async () => {
    runPipelineAgent.mockResolvedValue({
      reply: "Question",
      requiresUserInput: true,
      toolCalls: [],
    });

    await runQAPhase("pipe-1", "hello");

    expect(parseRequirementsFromSpec).not.toHaveBeenCalled();
    expect(initializeTargetProject).not.toHaveBeenCalled();

    const types = appendEvent.mock.calls.map((call) => call[1]);
    expect(types).toContain("qa_started");
    expect(types).toContain("agent_message");
  });

  it("completes QA and starts implementation loop", async () => {
    const runner = jest.fn(async () => {});
    setImplementationLoopRunner(runner);

    runPipelineAgent.mockResolvedValue({
      reply: "done",
      requiresUserInput: false,
      toolCalls: [
        {
          name: "Write",
          args: { file_path: "/fake/root/.claude/pipeline/feature-spec.v3.json" },
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

    expect(parseRequirementsFromSpec).toHaveBeenCalled();
    expect(setFeaturePrefix).toHaveBeenCalledWith("pipe-1", parsedFeaturePrefix);
    expect(setTargetProjectPath).toHaveBeenCalledWith("pipe-1", "/target/path");
    expect(initializeTargetProject).toHaveBeenCalledWith("/target/path");
    expect(setRequirements).toHaveBeenCalled();
    expect(setEpics).toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith("pipe-1", { totalRequirements: 1 });
    expect(runner).toHaveBeenCalledWith("pipe-1");

    const types = appendEvent.mock.calls.map((call) => call[1]);
    expect(types).toContain("qa_completed");
    expect(types).toContain("target_project_set");
  });

  it("fails when no requirements found", async () => {
    runPipelineAgent.mockResolvedValue({
      reply: "done",
      requiresUserInput: false,
      toolCalls: [
        {
          name: "Write",
          args: { file_path: "/fake/root/.claude/pipeline/feature-spec.v3.json" },
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
    expect(runPipelineAgentWithMessage).not.toHaveBeenCalled();
  });

  it("continues QA and emits events", async () => {
    runPipelineAgentWithMessage.mockResolvedValue({
      reply: "next",
      requiresUserInput: true,
      toolCalls: [],
    });

    await handleUserMessage("pipe-1", "message");

    expect(runPipelineAgentWithMessage).toHaveBeenCalledWith(
      "feature-qa",
      "message",
      pipeline?.conversationHistory ?? [],
      expect.any(Function),
      "/project/path",
      50,
      {},
      expect.any(Function)
    );

    const types = appendEvent.mock.calls.map((call) => call[1]);
    expect(types).toContain("user_message");
    expect(types).toContain("status_update");
    expect(types).toContain("agent_message");
  });
});
