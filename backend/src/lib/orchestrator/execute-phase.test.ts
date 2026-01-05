import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.restore();

const appendEvent = jest.fn();
const updatePhase = jest.fn();
const updateStatus = jest.fn();
const addArtifact = jest.fn();
const getPipeline = jest.fn();
const runPipelineAgent = jest.fn();
const saveDiff = jest.fn();
const createToolCallbacks = jest.fn(() => ({}));
const emitTodoEvents = jest.fn();
const logPhase = jest.fn();

let execStdout = "";
let execError: Error | null = null;
const execCalls: Array<{ cmd: string; options?: Record<string, unknown> }> = [];

const exec = (
  cmd: string,
  options: Record<string, unknown> | ((error: Error | null, stdout: string, stderr: string) => void),
  callback?: (error: Error | null, stdout: string, stderr: string) => void
) => {
  const cb = typeof options === "function" ? options : callback;
  execCalls.push({ cmd, options: typeof options === "function" ? undefined : options });
  if (!cb) return;
  if (execError) {
    cb(execError, "", "");
    return;
  }
  cb(null, execStdout, "");
};

(exec as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] = (
  cmd: string,
  options?: Record<string, unknown>
) => {
  execCalls.push({ cmd, options });
  if (execError) {
    return Promise.reject(execError);
  }
  return Promise.resolve({ stdout: execStdout, stderr: "" });
};

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
  saveDiff,
}));
mock.module("./callbacks", () => ({
  createToolCallbacks,
  emitTodoEvents,
}));
mock.module("./utils", () => ({
  logPhase,
}));
mock.module("node:child_process", () => ({ exec }));

const { runExecutePhase } = await import(`./execute-phase?test=${Date.now()}`);

beforeEach(() => {
  jest.clearAllMocks();
  execStdout = "";
  execError = null;
  execCalls.length = 0;
});

describe("runExecutePhase", () => {
  it("returns early when pipeline missing", async () => {
    getPipeline.mockReturnValue(undefined);
    await runExecutePhase("pipe-1", {
      id: "req-1",
      title: "Title",
      description: "Desc",
      priority: 1,
      status: "pending",
      acceptanceCriteria: [],
    });

    expect(runPipelineAgent).not.toHaveBeenCalled();
  });

  it("runs execution and captures diff", async () => {
    const pipeline = { targetProjectPath: "/tmp/project" };
    getPipeline.mockReturnValue(pipeline);

    runPipelineAgent.mockImplementation(async (_agent, _prompt, onStreamChunk) => {
      onStreamChunk?.("chunk");
      return { reply: "done", structuredOutput: { todos: [] } };
    });

    execStdout = "diff --git a/file b/file";
    saveDiff.mockResolvedValue({ id: "diff-1", type: "diff", path: "path" });

    await runExecutePhase("pipe-1", {
      id: "req-1",
      title: "Title",
      description: "Desc",
      priority: 1,
      status: "pending",
      acceptanceCriteria: [],
    });

    expect(updatePhase).toHaveBeenCalledWith("pipe-1", { current: "executing" });
    expect(updateStatus).toHaveBeenCalledWith("pipe-1", "executing");

    const [agent, _prompt, onStreamChunk, targetPath, maxTurns, toolCallbacks, playwrightOptions, modelOverride] =
      runPipelineAgent.mock.calls[0];

    expect(agent).toBe("feature-executor");
    expect(typeof onStreamChunk).toBe("function");
    expect(targetPath).toBe("/tmp/project");
    expect(maxTurns).toBeUndefined();
    expect(toolCallbacks).toEqual({});
    expect(playwrightOptions).toBeUndefined();
    expect(modelOverride).toBeUndefined();

    expect(emitTodoEvents).toHaveBeenCalledWith("pipe-1", "executing", { todos: [] });

    const streamCall = appendEvent.mock.calls.find(
      (call) => call[1] === "agent_message" && call[2].streaming === true
    );
    expect(streamCall?.[2].content).toBe("chunk");

    expect(saveDiff).toHaveBeenCalledWith(
      execStdout,
      "req-1",
      "/tmp/project"
    );

    expect(addArtifact).toHaveBeenCalledWith(
      "pipe-1",
      expect.objectContaining({
        id: "diff-1",
        type: "diff",
        path: "path",
        requirementId: "req-1",
      })
    );

    expect(execCalls[0]).toEqual({
      cmd: "git diff HEAD",
      options: { cwd: "/tmp/project", maxBuffer: 10 * 1024 * 1024 },
    });
  });

  it("skips diff saving when clean", async () => {
    const pipeline = { targetProjectPath: "/tmp/project" };
    getPipeline.mockReturnValue(pipeline);

    runPipelineAgent.mockResolvedValue({ reply: "done" });
    execStdout = "";

    await runExecutePhase("pipe-1", {
      id: "req-1",
      title: "Title",
      description: "Desc",
      priority: 1,
      status: "pending",
      acceptanceCriteria: [],
    });

    expect(saveDiff).not.toHaveBeenCalled();
    expect(addArtifact).not.toHaveBeenCalled();
  });
});
