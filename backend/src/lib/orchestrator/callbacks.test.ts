import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

mock.restore();

const appendEvent = jest.fn();
const logTool = jest.fn();
const truncateResult = jest.fn(() => "truncated");
const LOG = { error: "[Error]", test: "[Test]" };

mock.module("../pipeline", () => ({ appendEvent }));
mock.module("./utils", () => ({ LOG, logTool, truncateResult }));

const { createToolCallbacks, createServerLogCallbacks } = await import(
  `./callbacks?test=${Date.now()}`
);

describe("createToolCallbacks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("emits tool_started", () => {
    const callbacks = createToolCallbacks("pipe-1", "planning");
    callbacks.onToolStart?.("Read", { file_path: "file.ts" }, "tool-1");

    expect(logTool).toHaveBeenCalledWith(
      "Planning",
      "Read",
      { file_path: "file.ts" }
    );
    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "tool_started",
      expect.objectContaining({
        toolName: "Read",
        toolUseId: "tool-1",
        phase: "planning",
      })
    );
  });

  it("emits tool_completed with success outcome", () => {
    const callbacks = createToolCallbacks("pipe-1", "planning");
    callbacks.onToolComplete?.("Write", { file_path: "file.ts" }, "tool-2", "ok", 42);

    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "tool_completed",
      expect.objectContaining({
        toolName: "Write",
        toolUseId: "tool-2",
        durationMs: 42,
        result: "truncated",
        outcome: "success",
        phase: "planning",
      })
    );
  });

  it("emits tool_completed with warning outcome on error text", () => {
    const callbacks = createToolCallbacks("pipe-1", "planning");
    callbacks.onToolComplete?.("Shell", { command: "rm" }, "tool-3", "Error: failed", 10);

    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "tool_completed",
      expect.objectContaining({
        outcome: "warning",
      })
    );
  });

  it("emits tool_error and status_update", () => {
    const callbacks = createToolCallbacks("pipe-1", "planning");
    callbacks.onToolError?.("Shell", { command: "ls" }, "tool-4", "boom");
    callbacks.onStatusUpdate?.("Working");

    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "tool_error",
      expect.objectContaining({
        toolName: "Shell",
        toolUseId: "tool-4",
        error: "boom",
        phase: "planning",
      })
    );

    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "status_update",
      expect.objectContaining({ action: "Working", phase: "planning", statusSource: "agent" })
    );
  });
});

describe("createServerLogCallbacks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("emits server and status events", () => {
    const callbacks = createServerLogCallbacks("pipe-1");
    callbacks.onLog("web", "starting");
    callbacks.onHealthy("web");
    callbacks.onError("web", "boom");

    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "status_update",
      expect.objectContaining({ action: "[web] starting", phase: "testing", statusSource: "system" })
    );

    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "server_healthy",
      { platform: "web" }
    );

    expect(appendEvent).toHaveBeenCalledWith(
      "pipe-1",
      "server_error",
      { platform: "web", error: "boom" }
    );
  });
});
