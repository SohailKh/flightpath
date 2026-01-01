import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createAgentRunner, type AgentRunner } from "./lib/agent";
import {
  createRun,
  getRun,
  appendEvent,
  setOutput,
  setError,
  subscribe,
  isTerminal,
  type Run,
} from "./lib/runs";
import {
  createPipeline,
  getPipeline,
  getAllPipelines,
  hasActivePipeline,
  getActivePipelineId,
  requestPause,
  requestAbort,
  resume as resumePipelineState,
  subscribe as subscribePipeline,
  isTerminal as isPipelineTerminal,
  clearPipelines,
  type Pipeline,
} from "./lib/pipeline";
import {
  runQAPhase,
  handleUserMessage,
  resumePipeline,
} from "./lib/orchestrator";
import {
  getArtifact,
  listArtifacts,
  getContentType,
} from "./lib/artifacts";

type Bindings = {
  ANTHROPIC_API_KEY?: string;
};

type Variables = {
  agentRunner: AgentRunner;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// CORS middleware for dev UI (Vite default port)
app.use(
  "/*",
  cors({
    origin: ["http://localhost:5173"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

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

// Run request schema (same as agent)
const RunRequestSchema = z.object({
  message: z.string().min(1, "message is required"),
});

// Create a new run (returns immediately, executes in background)
app.post("/api/runs", async (c) => {
  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = RunRequestSchema.safeParse(body);
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

  // Create run in queued status
  const run = createRun(message);
  appendEvent(run.id, "received", { message });

  // Execute in background (non-blocking)
  const agentRunner = c.get("agentRunner");
  setTimeout(async () => {
    try {
      appendEvent(run.id, "calling_agent", {});
      const result = await agentRunner.run(message);
      setOutput(run.id, result.reply);
      appendEvent(run.id, "agent_reply", { reply: result.reply });
      appendEvent(run.id, "completed", { requestId: result.requestId });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      setError(run.id, errorMessage);
      appendEvent(run.id, "failed", { error: errorMessage });
    }
  }, 0);

  return c.json({ runId: run.id });
});

// Get run by ID
app.get("/api/runs/:id", (c) => {
  const runId = c.req.param("id");
  const run = getRun(runId);

  if (!run) {
    return c.json({ error: "Run not found" }, 404);
  }

  return c.json(run);
});

// SSE endpoint for run events
app.get("/api/runs/:id/events", async (c) => {
  const runId = c.req.param("id");
  const run = getRun(runId);

  if (!run) {
    return c.json({ error: "Run not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    // 1. Send all existing events first
    for (const event of run.events) {
      await stream.writeSSE({
        event: "run_event",
        data: JSON.stringify(event),
      });
    }

    // 2. If run is already complete, send done and close
    if (isTerminal(run.id)) {
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ status: run.status }),
      });
      return;
    }

    // 3. Subscribe to new events until completion
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribe(run.id, async (event) => {
        try {
          await stream.writeSSE({
            event: "run_event",
            data: JSON.stringify(event),
          });

          if (event.type === "completed" || event.type === "failed") {
            const currentRun = getRun(run.id);
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ status: currentRun?.status }),
            });
            unsubscribe();
            resolve();
          }
        } catch (err) {
          // Stream might be closed, ignore write errors
          console.error("SSE write error:", err);
          unsubscribe();
          resolve();
        }
      });

      // Handle client disconnect
      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });
    });
  });
});

// ============================================
// Pipeline API Endpoints
// ============================================

// Pipeline request schema
const PipelineRequestSchema = z.object({
  initialPrompt: z.string().min(1, "initialPrompt is required"),
});

// Create a new pipeline
app.post("/api/pipelines", async (c) => {
  // Check if there's already an active pipeline
  if (hasActivePipeline()) {
    return c.json(
      {
        error: "A pipeline is already active",
        activePipelineId: getActivePipelineId(),
      },
      409
    );
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = PipelineRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Validation error",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { initialPrompt } = parsed.data;

  // Create pipeline
  const pipeline = createPipeline(initialPrompt);
  if (!pipeline) {
    return c.json({ error: "Failed to create pipeline" }, 500);
  }

  // Start QA phase in background
  setTimeout(() => {
    runQAPhase(pipeline.id, initialPrompt).catch((err) => {
      console.error("QA phase error:", err);
    });
  }, 0);

  return c.json({ pipelineId: pipeline.id });
});

// Get all pipelines
app.get("/api/pipelines", (c) => {
  const pipelines = getAllPipelines();
  return c.json({
    pipelines: pipelines.map((p) => ({
      id: p.id,
      status: p.status,
      createdAt: p.createdAt,
      phase: p.phase,
      requirementsCount: p.requirements.length,
    })),
    activePipelineId: getActivePipelineId(),
  });
});

// Get pipeline by ID
app.get("/api/pipelines/:id", (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  return c.json(pipeline);
});

// SSE endpoint for pipeline events
app.get("/api/pipelines/:id/events", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  return streamSSE(c, async (stream) => {
    // 1. Send all existing events first
    for (const event of pipeline.events) {
      await stream.writeSSE({
        event: "pipeline_event",
        data: JSON.stringify(event),
      });
    }

    // 2. If pipeline is already complete, send done and close
    if (isPipelineTerminal(pipeline.id)) {
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ status: pipeline.status }),
      });
      return;
    }

    // 3. Subscribe to new events until completion
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribePipeline(pipeline.id, async (event) => {
        try {
          await stream.writeSSE({
            event: "pipeline_event",
            data: JSON.stringify(event),
          });

          if (
            event.type === "pipeline_completed" ||
            event.type === "pipeline_failed" ||
            event.type === "aborted"
          ) {
            const currentPipeline = getPipeline(pipeline.id);
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({ status: currentPipeline?.status }),
            });
            unsubscribe();
            resolve();
          }
        } catch (err) {
          console.error("SSE write error:", err);
          unsubscribe();
          resolve();
        }
      });

      // Handle client disconnect
      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });
    });
  });
});

// Message request schema
const MessageRequestSchema = z.object({
  message: z.string().min(1, "message is required"),
});

// Send user message during QA phase
app.post("/api/pipelines/:id/message", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  if (pipeline.phase.current !== "qa") {
    return c.json(
      { error: "Messages only allowed during QA phase" },
      400
    );
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = MessageRequestSchema.safeParse(body);
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

  // Handle message in background
  setTimeout(() => {
    handleUserMessage(pipelineId, message).catch((err) => {
      console.error("Message handling error:", err);
    });
  }, 0);

  return c.json({ ok: true });
});

// Pause pipeline
app.post("/api/pipelines/:id/pause", (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  if (isPipelineTerminal(pipelineId)) {
    return c.json({ error: "Pipeline already in terminal state" }, 400);
  }

  const success = requestPause(pipelineId);
  return c.json({ ok: success });
});

// Abort pipeline
app.post("/api/pipelines/:id/abort", (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  if (isPipelineTerminal(pipelineId)) {
    return c.json({ error: "Pipeline already in terminal state" }, 400);
  }

  const success = requestAbort(pipelineId);
  return c.json({ ok: success });
});

// Resume pipeline
app.post("/api/pipelines/:id/resume", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  if (pipeline.status !== "paused") {
    return c.json({ error: "Pipeline is not paused" }, 400);
  }

  resumePipelineState(pipelineId);

  // Resume in background
  setTimeout(() => {
    resumePipeline(pipelineId).catch((err) => {
      console.error("Resume error:", err);
    });
  }, 0);

  return c.json({ ok: true });
});

// List artifacts for a pipeline
app.get("/api/pipelines/:id/artifacts", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  const artifacts = await listArtifacts(pipelineId);
  return c.json({ artifacts });
});

// Get artifact by ID
app.get("/api/pipelines/:id/artifacts/:artifactId", async (c) => {
  const pipelineId = c.req.param("id");
  const artifactId = c.req.param("artifactId");

  const pipeline = getPipeline(pipelineId);
  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  const data = await getArtifact(pipelineId, artifactId);
  if (!data) {
    return c.json({ error: "Artifact not found" }, 404);
  }

  const contentType = getContentType(artifactId);
  return new Response(data, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.length),
    },
  });
});

// ============================================

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

// Re-export runs functions for testing
export { clearRuns, getRun } from "./lib/runs";

// Re-export pipeline functions for testing
export { clearPipelines, getPipeline } from "./lib/pipeline";
