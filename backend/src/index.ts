import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
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
  isRunning as isPipelineRunning,
  clearPipelines,
  type Pipeline,
} from "./lib/pipeline";
import {
  runQAPhase,
  handleUserMessage,
} from "./lib/orchestrator";
import { runHarness } from "./lib/harness";
import {
  getArtifact,
  listArtifacts,
  getContentType,
} from "./lib/artifacts";
import { FLIGHTPATH_ROOT } from "./lib/orchestrator/project-init";
import { analyzeFlow } from "./lib/flow-analyzer";

type Bindings = {
  ANTHROPIC_API_KEY?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS middleware for dev UI (Vite default port)
app.use(
  "/*",
  cors({
    origin: ["http://localhost:5173"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

// Health check
app.get("/health", (c) => {
  return c.json({ ok: true });
});

// ============================================
// Pipeline API Endpoints
// ============================================

// Pipeline request schema
const PipelineRequestSchema = z.object({
  initialPrompt: z.string().min(1, "initialPrompt is required"),
  targetProjectPath: z.string().optional(),
});

// Create a new pipeline
app.post("/api/pipelines", async (c) => {
  // Check if there's already an active pipeline
  if (hasActivePipeline()) {
    console.log(`[API] POST /api/pipelines rejected - active pipeline exists: ${getActivePipelineId()}`);
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

  const { initialPrompt, targetProjectPath } = parsed.data;
  const truncatedPrompt = initialPrompt.length > 80 ? initialPrompt.slice(0, 77) + "..." : initialPrompt;
  console.log(`[API] POST /api/pipelines {initialPrompt: "${truncatedPrompt}"}`);

  // Create pipeline
  const pipeline = createPipeline(initialPrompt, targetProjectPath);
  if (!pipeline) {
    return c.json({ error: "Failed to create pipeline" }, 500);
  }

  // Start QA phase in background
  console.log(`[API] Pipeline ${pipeline.id} created, starting QA phase...`);
  setTimeout(() => {
    runQAPhase(pipeline.id, initialPrompt, targetProjectPath).catch((err) => {
      console.error("[API] QA phase error:", err);
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

  // Include isRunning in response so UI can determine button visibility
  return c.json({
    ...pipeline,
    isRunning: isPipelineRunning(pipelineId),
  });
});

// SSE endpoint for pipeline events
app.get("/api/pipelines/:id/events", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  console.log(`[API] SSE connected for pipeline ${pipelineId}`);

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
  const truncatedMsg = message.length > 60 ? message.slice(0, 57) + "..." : message;
  console.log(`[API] POST /api/pipelines/${pipelineId}/message: "${truncatedMsg}"`);

  // Handle message in background
  setTimeout(() => {
    handleUserMessage(pipelineId, message).catch((err) => {
      console.error("[API] Message handling error:", err);
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

  console.log(`[API] POST /api/pipelines/${pipelineId}/pause`);
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

  console.log(`[API] POST /api/pipelines/${pipelineId}/abort`);
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

  console.log(`[API] POST /api/pipelines/${pipelineId}/resume`);
  resumePipelineState(pipelineId);

  // Get pending requirements and resume with harness
  const pendingRequirements = pipeline.requirements.filter(
    (r) => r.status === "pending" || r.status === "in_progress"
  );

  if (pendingRequirements.length === 0) {
    return c.json({ ok: true, message: "No pending requirements" });
  }

  // Resume in background with harness
  setTimeout(() => {
    runHarness({
      pipelineId,
      requirements: pendingRequirements,
      targetProjectPath: pipeline.targetProjectPath || process.cwd(),
      model: "opus",
      maxTurns: 500,
      enablePlaywright: true,
    }).catch((err: Error) => {
      console.error("[API] Resume error:", err);
    });
  }, 0);

  return c.json({ ok: true });
});

// Go - resume an orphaned pipeline (e.g., after server restart)
app.post("/api/pipelines/:id/go", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  if (isPipelineTerminal(pipelineId)) {
    return c.json({ error: "Pipeline is in terminal state" }, 400);
  }

  if (isPipelineRunning(pipelineId)) {
    return c.json({ error: "Pipeline is already running" }, 400);
  }

  // QA phase requires user interaction, can't auto-resume
  if (pipeline.phase.current === "qa") {
    return c.json({ error: "QA phase requires user message to continue" }, 400);
  }

  console.log(`[API] POST /api/pipelines/${pipelineId}/go - resuming from ${pipeline.phase.current}`);

  // Get pending requirements and resume with harness
  const pendingRequirements = pipeline.requirements.filter(
    (r) => r.status === "pending" || r.status === "in_progress"
  );

  if (pendingRequirements.length === 0) {
    return c.json({ error: "No pending requirements to process" }, 400);
  }

  // Resume in background with harness
  setTimeout(() => {
    runHarness({
      pipelineId,
      requirements: pendingRequirements,
      targetProjectPath: pipeline.targetProjectPath || process.cwd(),
      model: "opus",
      maxTurns: 500,
      enablePlaywright: true,
    }).catch((err) => {
      console.error("[API] Go error:", err);
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

  const artifactsRoot = pipeline.isNewProject
    ? pipeline.targetProjectPath || FLIGHTPATH_ROOT
    : pipeline.featurePrefix
    ? FLIGHTPATH_ROOT
    : pipeline.targetProjectPath;
  const artifactsPrefix = pipeline.featurePrefix || "pipeline";
  const artifacts = await listArtifacts(artifactsRoot, artifactsPrefix);
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

  const artifactsRoot = pipeline.isNewProject
    ? pipeline.targetProjectPath || FLIGHTPATH_ROOT
    : pipeline.featurePrefix
    ? FLIGHTPATH_ROOT
    : pipeline.targetProjectPath;
  const artifactsPrefix = pipeline.featurePrefix || "pipeline";
  const data = await getArtifact(artifactId, artifactsRoot, artifactsPrefix);
  if (!data) {
    return c.json({ error: "Artifact not found" }, 404);
  }

  const contentType = getContentType(artifactId);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.length),
    },
  });
});

// Analyze pipeline flow for improvement suggestions
app.post("/api/pipelines/:id/analyze", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  try {
    const result = await analyzeFlow(pipeline);
    return c.json(result);
  } catch (err) {
    console.error("Analysis error:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Analysis failed" },
      500
    );
  }
});

// ============================================

const port = parseInt(process.env.PORT || "8787", 10);

// For Bun runtime (auto-starts server)
console.log(`[Backend] Starting server on port ${port}...`);
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

// Re-export pipeline functions for testing
export { clearPipelines, getPipeline } from "./lib/pipeline";
