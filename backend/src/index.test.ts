import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { app } from "./index";
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
});
