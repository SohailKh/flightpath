import { describe, expect, it, mock } from "bun:test";

mock.restore();

mock.module("./qa-phase", () => ({
  runQAPhase: () => {},
  handleUserMessage: () => {},
}));
mock.module("../harness", () => ({
  runHarness: () => {},
}));

const orchestrator = await import(`./index?test=${Date.now()}`);

describe("orchestrator index", () => {
  it("exports the public API", () => {
    expect(typeof orchestrator.runQAPhase).toBe("function");
    expect(typeof orchestrator.handleUserMessage).toBe("function");
    expect(typeof orchestrator.runHarness).toBe("function");
  });
});
