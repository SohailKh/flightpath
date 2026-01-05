import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.restore();

const appendEvent = jest.fn();
const updatePhase = jest.fn();
const updateStatus = jest.fn();
const getPipeline = jest.fn();
const runPipelineAgent = jest.fn();
const createToolCallbacks = jest.fn(() => ({}));
const emitTodoEvents = jest.fn();
const logPhase = jest.fn();

mock.module("../pipeline", () => ({
  getPipeline,
  updatePhase,
  updateStatus,
  appendEvent,
}));
mock.module("../agent", () => ({
  runPipelineAgent,
}));
mock.module("./callbacks", () => ({
  createToolCallbacks,
  emitTodoEvents,
}));
mock.module("./utils", () => ({
  logPhase,
}));

const { runPlanPhase } = await import(`./plan-phase?test=${Date.now()}`);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runPlanPhase", () => {
  it("returns early when pipeline missing", async () => {
    getPipeline.mockReturnValue(undefined);
    await runPlanPhase("pipe-1", {
      id: "req-1",
      title: "Title",
      description: "Desc",
      priority: 1,
      status: "pending",
      acceptanceCriteria: [],
    });
    expect(runPipelineAgent).not.toHaveBeenCalled();
  });

  it("builds prompt and emits events", async () => {
    const pipeline = { targetProjectPath: "/tmp/project" };
    getPipeline.mockReturnValue(pipeline);

    runPipelineAgent.mockImplementation(async (_agent, prompt, onStreamChunk) => {
      onStreamChunk?.("chunk");
      return {
        reply: "plan reply",
        structuredOutput: { todos: [] },
      };
    });

    const requirement = {
      id: "req-1",
      title: "Title",
      description: "Desc",
      priority: 1,
      status: "pending",
      acceptanceCriteria: ["A1", "A2"],
    };

    await runPlanPhase("pipe-1", requirement);

    const [agent, prompt, onStreamChunk, targetPath, maxTurns, toolCallbacks, playwrightOptions, modelOverride] =
      runPipelineAgent.mock.calls[0];

    expect(agent).toBe("feature-planner");
    expect(prompt).toContain("Acceptance Criteria");
    expect(prompt).toContain("- A1");
    expect(prompt).toContain("- A2");
    expect(typeof onStreamChunk).toBe("function");
    expect(targetPath).toBe("/tmp/project");
    expect(maxTurns).toBeUndefined();
    expect(toolCallbacks).toEqual({});
    expect(playwrightOptions).toBeUndefined();
    expect(modelOverride).toBeUndefined();

    expect(emitTodoEvents).toHaveBeenCalledWith("pipe-1", "planning", { todos: [] });

    expect(updatePhase).toHaveBeenCalledWith("pipe-1", { current: "planning" });
    expect(updateStatus).toHaveBeenCalledWith("pipe-1", "planning");

    const types = appendEvent.mock.calls.map((call) => call[1]);
    expect(types).toContain("planning_started");
    expect(types).toContain("planning_completed");
    expect(types).toContain("agent_message");
  });
});
