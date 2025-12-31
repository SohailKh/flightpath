import { Hono } from "hono";
import { z } from "zod";
import { createAgentRunner, type AgentRunner } from "./lib/agent";

type Bindings = {
  ANTHROPIC_API_KEY?: string;
};

type Variables = {
  agentRunner: AgentRunner;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Middleware to inject agent runner (allows test mocking)
app.use("/api/*", async (c, next) => {
  if (!c.get("agentRunner")) {
    c.set("agentRunner", createAgentRunner());
  }
  await next();
});

// Health check
app.get("/health", (c) => {
  return c.json({ ok: true });
});

// Agent message endpoint
const AgentRequestSchema = z.object({
  message: z.string().min(1, "message is required"),
});

app.post("/api/agent", async (c) => {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = AgentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Validation error",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { message } = parsed.data;

  try {
    const agentRunner = c.get("agentRunner");
    const result = await agentRunner.run(message);
    return c.json({
      reply: result.reply,
      requestId: result.requestId,
    });
  } catch (error) {
    console.error("Agent error:", error);
    return c.json(
      {
        error: "Agent execution failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

const port = parseInt(process.env.PORT || "8787", 10);

// For Bun runtime (auto-starts server)
export default {
  port,
  fetch: app.fetch,
};

// For Node.js/tsx runtime (manual server start)
if (typeof Bun === "undefined") {
  const { serve } = await import("@hono/node-server");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

// Also export app for testing
export { app };
