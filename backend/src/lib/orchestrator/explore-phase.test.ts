import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.restore();

const appendEvent = jest.fn();
const updatePhase = jest.fn();
const updateStatus = jest.fn();
const getPipeline = jest.fn();
const runParallelExplorers = jest.fn();
const createToolCallbacks = jest.fn(() => ({}));
const logPhase = jest.fn();

mock.module("../pipeline", () => ({
  getPipeline,
  updatePhase,
  updateStatus,
  appendEvent,
}));
mock.module("../parallel-explorer", () => ({
  runParallelExplorers,
}));
mock.module("./callbacks", () => ({
  createToolCallbacks,
}));
mock.module("./utils", () => ({
  logPhase,
}));

const { runExplorePhase } = await import(`./explore-phase?test=${Date.now()}`);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runExplorePhase", () => {
  it("throws when pipeline not found", async () => {
    getPipeline.mockReturnValue(undefined);
    await expect(
      runExplorePhase("pipe-1", { id: "req-1", title: "Title" })
    ).rejects.toThrow("Pipeline not found");
  });

  it("runs exploration and emits events", async () => {
    const pipeline = { targetProjectPath: "/tmp/project" };
    getPipeline.mockReturnValue(pipeline);

    const result = {
      requirementId: "req-1",
      explorers: [
        {
          type: "pattern",
          patterns: [],
          relatedFiles: { templates: [], types: [], tests: [] },
          apiEndpoints: [],
          testPatterns: [],
          notes: [],
          duration: 10,
          model: "haiku",
        },
      ],
      merged: {
        patterns: [],
        relatedFiles: { templates: [], types: [], tests: [] },
        apiEndpoints: [],
        notes: [],
      },
      totalDuration: 20,
      selectedModel: "haiku",
      complexityScore: 0,
    };

    runParallelExplorers.mockResolvedValue(result);

    const requirement = { id: "req-1", title: "Title" };
    const output = await runExplorePhase("pipe-1", requirement, "low");

    expect(output).toBe(result);
    expect(updatePhase).toHaveBeenCalledWith("pipe-1", { current: "exploring" });
    expect(updateStatus).toHaveBeenCalledWith("pipe-1", "exploring");

    expect(runParallelExplorers).toHaveBeenCalledWith(
      "pipe-1",
      requirement,
      "/tmp/project",
      "low",
      {}
    );

    const agentMessage = appendEvent.mock.calls.find((call) => call[1] === "agent_message");
    expect(agentMessage?.[2].content).toContain("Exploration Summary");
  });
});
