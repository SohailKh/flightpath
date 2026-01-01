import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { app, clearRuns, getRun } from "./index";
import type { AgentRunner } from "./lib/agent";

// Mock agent runner for testing (no real API calls)
const mockAgentRunner: AgentRunner = {
  async run(message: string) {
    return {
      reply: `Mock reply to: ${message}`,
      requestId: "test-request-id-123",
    };
  },
};

describe("Backend API", () => {
  describe("GET /health", () => {
    it("returns ok: true", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });
  });

  describe("POST /api/agent", () => {
    // Create a test app with mocked agent runner
    const testApp = new Hono();
    testApp.use("/api/*", async (c, next) => {
      c.set("agentRunner", mockAgentRunner);
      await next();
    });
    testApp.route("/", app);

    it("returns 400 for missing body", async () => {
      const res = await testApp.request("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json{",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 400 for missing message field", async () => {
      const res = await testApp.request("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation error");
    });

    it("returns 400 for empty message", async () => {
      const res = await testApp.request("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation error");
    });

    it("returns reply for valid message", async () => {
      const res = await testApp.request("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello world" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reply).toBe("Mock reply to: hello world");
      expect(body.requestId).toBe("test-request-id-123");
    });
  });

  describe("POST /api/runs", () => {
    // Create a test app with mocked agent runner
    const testApp = new Hono();
    testApp.use("/api/*", async (c, next) => {
      c.set("agentRunner", mockAgentRunner);
      await next();
    });
    testApp.route("/", app);

    beforeEach(() => {
      clearRuns();
    });

    it("returns 400 for missing body", async () => {
      const res = await testApp.request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid json{",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid JSON body");
    });

    it("returns 400 for missing message field", async () => {
      const res = await testApp.request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Validation error");
    });

    it("returns runId for valid message", async () => {
      const res = await testApp.request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello world" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runId).toBeDefined();
      expect(typeof body.runId).toBe("string");
    });
  });

  describe("GET /api/runs/:id", () => {
    const testApp = new Hono();
    testApp.use("/api/*", async (c, next) => {
      c.set("agentRunner", mockAgentRunner);
      await next();
    });
    testApp.route("/", app);

    beforeEach(() => {
      clearRuns();
    });

    it("returns 404 for non-existent run", async () => {
      const res = await testApp.request("/api/runs/non-existent-id");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe("Run not found");
    });

    it("returns run object for existing run", async () => {
      // First create a run
      const createRes = await testApp.request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test message" }),
      });
      const { runId } = await createRes.json();

      // Then fetch it
      const res = await testApp.request(`/api/runs/${runId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(runId);
      expect(body.input.message).toBe("test message");
      expect(body.events.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/runs/:id/events (SSE)", () => {
    const testApp = new Hono();
    testApp.use("/api/*", async (c, next) => {
      c.set("agentRunner", mockAgentRunner);
      await next();
    });
    testApp.route("/", app);

    beforeEach(() => {
      clearRuns();
    });

    it("returns 404 for non-existent run", async () => {
      const res = await testApp.request("/api/runs/non-existent-id/events");
      expect(res.status).toBe(404);
    });

    it("returns text/event-stream content type", async () => {
      // Create a run first
      const createRes = await testApp.request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test message" }),
      });
      const { runId } = await createRes.json();

      // Wait for run to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      const res = await testApp.request(`/api/runs/${runId}/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("streams events and done for completed run", async () => {
      // Create a run
      const createRes = await testApp.request("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      const { runId } = await createRes.json();

      // Wait for background execution to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Fetch events
      const res = await testApp.request(`/api/runs/${runId}/events`);
      const text = await res.text();

      // Should contain run_event and done events
      expect(text).toContain("event: run_event");
      expect(text).toContain("event: done");
      expect(text).toContain('"type":"received"');
      expect(text).toContain('"type":"completed"');
    });
  });
});
