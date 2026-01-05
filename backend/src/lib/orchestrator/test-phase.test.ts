import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.restore();

const appendEvent = jest.fn();
const updatePhase = jest.fn();
const updateStatus = jest.fn();
const addArtifact = jest.fn();
const getPipeline = jest.fn();
const runPipelineAgent = jest.fn();
const saveScreenshot = jest.fn();
const saveTestResult = jest.fn();
const startDevServers = jest.fn();
const stopDevServers = jest.fn();
const captureWebScreenshot = jest.fn();
const closeBrowser = jest.fn();
const createToolCallbacks = jest.fn(() => ({}));
const createServerLogCallbacks = jest.fn(() => ({}));
const logPhase = jest.fn();
const LOG = { test: "[Test]" };

mock.module("../pipeline", () => ({
  getPipeline,
  updatePhase,
  updateStatus,
  appendEvent,
  addArtifact,
}));
mock.module("../agent", () => ({
  runPipelineAgent,
}));
mock.module("../artifacts", () => ({
  saveScreenshot,
  saveTestResult,
}));
mock.module("../dev-server", () => ({
  startDevServers,
  stopDevServers,
}));
mock.module("../screenshot", () => ({
  captureWebScreenshot,
  closeBrowser,
}));
mock.module("./callbacks", () => ({
  createToolCallbacks,
  createServerLogCallbacks,
}));
mock.module("./utils", () => ({
  LOG,
  logPhase,
}));

const { runTestPhase } = await import(`./test-phase?test=${Date.now()}`);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("runTestPhase", () => {
  it("returns false when pipeline missing", async () => {
    getPipeline.mockReturnValue(undefined);
    const passed = await runTestPhase("pipe-1", {
      id: "req-1",
      title: "Title",
      description: "Desc",
      priority: 1,
      status: "pending",
      acceptanceCriteria: [],
    });
    expect(passed).toBe(false);
  });

  it("captures screenshots and passes tests", async () => {
    const pipeline = { targetProjectPath: "/tmp/project" };
    getPipeline.mockReturnValue(pipeline);

    startDevServers.mockResolvedValue({
      servers: [
        {
          platform: "web",
          healthCheckUrl: "http://localhost:3000",
          healthy: true,
        },
      ],
      allHealthy: true,
      errors: [],
    });

    captureWebScreenshot.mockResolvedValue(Buffer.from("image"));
    saveScreenshot.mockResolvedValue({ id: "shot-1", type: "screenshot", path: "path" });

    runPipelineAgent.mockImplementation(async (_agent, _prompt, onStreamChunk) => {
      onStreamChunk?.("chunk");
      return { reply: "All tests passed" };
    });

    saveTestResult.mockResolvedValue({ id: "test-1", type: "test_result", path: "path" });

    const passed = await runTestPhase("pipe-1", {
      id: "req-1",
      title: "Title",
      description: "Desc",
      priority: 1,
      status: "pending",
      acceptanceCriteria: ["A1"],
    });

    expect(passed).toBe(true);
    expect(addArtifact).toHaveBeenCalledWith(
      "pipe-1",
      expect.objectContaining({ id: "shot-1", type: "screenshot" })
    );
    expect(addArtifact).toHaveBeenCalledWith(
      "pipe-1",
      expect.objectContaining({ id: "test-1", type: "test_result" })
    );
    expect(stopDevServers).toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalled();

    const types = appendEvent.mock.calls.map((call) => call[1]);
    expect(types).toContain("test_passed");
    expect(types).toContain("testing_completed");
  });

  it("reports explicit failure reason", async () => {
    const pipeline = { targetProjectPath: "/tmp/project" };
    getPipeline.mockReturnValue(pipeline);

    startDevServers.mockResolvedValue({
      servers: [],
      allHealthy: true,
      errors: [],
    });

    runPipelineAgent.mockResolvedValue({ reply: "Error: Something broke" });
    saveTestResult.mockResolvedValue({ id: "test-2", type: "test_result", path: "path" });

    const passed = await runTestPhase("pipe-1", {
      id: "req-1",
      title: "Title",
      description: "Desc",
      priority: 1,
      status: "pending",
      acceptanceCriteria: [],
    });

    expect(passed).toBe(false);

    const failedEvent = appendEvent.mock.calls.find((call) => call[1] === "test_failed");
    expect(failedEvent?.[2].reason).toBe("Something broke");
  });
});
