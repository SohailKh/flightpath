import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.restore();

let pipeline: {
  requirements: Array<{ id: string; title: string; status: string }>;
  phase: { current: string; requirementIndex: number; totalRequirements: number; retryCount: number };
  status: string;
} | undefined;

const getPipeline = jest.fn(() => pipeline);
const updatePhase = jest.fn((_id, updates) => {
  if (!pipeline) return;
  pipeline.phase = { ...pipeline.phase, ...updates };
});
const updateStatus = jest.fn((_id, status) => {
  if (pipeline) pipeline.status = status;
});
const updateRequirement = jest.fn((_id, requirementId, status) => {
  if (!pipeline) return;
  const req = pipeline.requirements.find((r) => r.id === requirementId);
  if (req) req.status = status;
});
const updateEpicProgress = jest.fn();
const appendEvent = jest.fn();
let pauseRequested = false;
let abortRequested = false;
const isPauseRequested = jest.fn(() => pauseRequested);
const isAbortRequested = jest.fn(() => abortRequested);

const runExplorePhase = jest.fn();
const runPlanPhase = jest.fn();
const runExecutePhase = jest.fn();
const runTestPhase = jest.fn();
const categorizeError = jest.fn(() => "unknown");
let registeredRunner: ((pipelineId: string) => Promise<void>) | null = null;
const setImplementationLoopRunner = jest.fn((runner) => {
  registeredRunner = runner;
});

const explorationResult = {
  merged: {
    patterns: [],
    relatedFiles: { templates: [], types: [], tests: [] },
    apiEndpoints: [],
    notes: [],
  },
  selectedModel: "haiku",
};

mock.module("../pipeline", () => ({
  getPipeline,
  updatePhase,
  updateStatus,
  updateRequirement,
  updateEpicProgress,
  appendEvent,
  isPauseRequested,
  isAbortRequested,
}));
mock.module("../parallel-explorer", () => ({
  categorizeError,
}));
mock.module("./explore-phase", () => ({
  runExplorePhase,
}));
mock.module("./plan-phase", () => ({
  runPlanPhase,
}));
mock.module("./execute-phase", () => ({
  runExecutePhase,
}));
mock.module("./test-phase", () => ({
  runTestPhase,
}));
mock.module("./qa-phase", () => ({
  setImplementationLoopRunner,
}));

const { runImplementationLoop, resumePipeline } = await import(`./loop?test=${Date.now()}`);

beforeEach(() => {
  jest.clearAllMocks();
  pipeline = {
    requirements: [{ id: "req-1", title: "Title", status: "pending" }],
    phase: { current: "qa", requirementIndex: 0, totalRequirements: 1, retryCount: 0 },
    status: "qa",
  };
  pauseRequested = false;
  abortRequested = false;
  runExplorePhase.mockResolvedValue(explorationResult);
  runPlanPhase.mockResolvedValue(undefined);
  runExecutePhase.mockResolvedValue(undefined);
  runTestPhase.mockResolvedValue(true);
  categorizeError.mockReturnValue("unknown");
});

describe("runImplementationLoop", () => {
  it("registers loop runner on load", () => {
    expect(registeredRunner).toBe(runImplementationLoop);
  });

  it("runs phases in order and completes", async () => {
    const order: string[] = [];
    runExplorePhase.mockImplementation(async () => {
      order.push("explore");
      return explorationResult;
    });
    runPlanPhase.mockImplementation(async () => order.push("plan"));
    runExecutePhase.mockImplementation(async () => order.push("execute"));
    runTestPhase.mockImplementation(async () => {
      order.push("test");
      return true;
    });

    await runImplementationLoop("pipe-1");

    expect(order).toEqual(["explore", "plan", "execute", "test"]);
    expect(updateRequirement).toHaveBeenCalledWith("pipe-1", "req-1", "in_progress");
    expect(updateRequirement).toHaveBeenCalledWith("pipe-1", "req-1", "completed");

    const pipelineCompleted = appendEvent.mock.calls.find((call) => call[1] === "pipeline_completed");
    expect(pipelineCompleted?.[2]).toEqual({ totalRequirements: 1, completed: 1, failed: 0 });
    expect(updateStatus).toHaveBeenCalledWith("pipe-1", "completed");
  });

  it("retries when tests fail", async () => {
    runTestPhase.mockResolvedValue(false);

    await runImplementationLoop("pipe-1");

    expect(runExplorePhase).toHaveBeenCalledTimes(3);
    expect(runPlanPhase).toHaveBeenCalledTimes(3);
    expect(runExecutePhase).toHaveBeenCalledTimes(3);
    expect(runTestPhase).toHaveBeenCalledTimes(3);

    const retryEvents = appendEvent.mock.calls.filter((call) => call[1] === "retry_started");
    expect(retryEvents.length).toBe(2);

    const pipelineCompleted = appendEvent.mock.calls.find((call) => call[1] === "pipeline_completed");
    expect(pipelineCompleted?.[2]).toEqual({ totalRequirements: 1, completed: 0, failed: 1 });
  });

  it("skips retries on configuration errors", async () => {
    runExplorePhase.mockImplementation(async () => {
      throw new Error("not found");
    });
    categorizeError.mockReturnValue("configuration");

    await runImplementationLoop("pipe-1");

    expect(runPlanPhase).not.toHaveBeenCalled();
    expect(runExecutePhase).not.toHaveBeenCalled();
    expect(runTestPhase).not.toHaveBeenCalled();

    const failureEvent = appendEvent.mock.calls.find((call) => call[1] === "requirement_failed");
    expect(failureEvent?.[2]).toEqual(
      expect.objectContaining({ reason: "Configuration error - retry would not help" })
    );
  });
});

describe("resumePipeline", () => {
  it("returns early when not paused", async () => {
    if (pipeline) pipeline.status = "qa";
    await resumePipeline("pipe-1");
    expect(runExplorePhase).not.toHaveBeenCalled();
  });

  it("resumes implementation loop when paused", async () => {
    if (pipeline) {
      pipeline.status = "paused";
      pipeline.phase.current = "planning";
    }

    await resumePipeline("pipe-1");

    expect(runExplorePhase).toHaveBeenCalled();
  });
});
