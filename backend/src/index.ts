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
  appendEvent,
  requestPause,
  requestAbort,
  resume as resumePipelineState,
  addUserInput,
  clearUserInputRequest,
  subscribe as subscribePipeline,
  isTerminal as isPipelineTerminal,
  isRunning as isPipelineRunning,
  clearPipelines,
  getPendingUserInputRequest,
  addUserInputResponse,
  type Pipeline,
} from "./lib/pipeline";
import type { AskUserInputResponse, UserInputFieldResponse, SecretInputField } from "./lib/agent";
import {
  storeSecretToEnv,
  storeUploadedFile,
} from "./lib/user-inputs";
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
// FLIGHTPATH_ROOT import removed - artifacts now use centralized storage via claudeStorageId
import { analyzeFlow } from "./lib/flow-analyzer";
import { getTelegramConfig, isTelegramChatAllowed } from "./lib/telegram";

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

function enqueuePipelineMessage(
  pipeline: Pipeline,
  message: string
): { ok: boolean; status?: number; error?: string } {
  if (pipeline.phase.current === "qa") {
    setTimeout(() => {
      handleUserMessage(pipeline.id, message).catch((err) => {
        console.error("[API] Message handling error:", err);
      });
    }, 0);
    return { ok: true };
  }

  if (pipeline.awaitingUserInput) {
    setTimeout(() => {
      try {
        const current = getPipeline(pipeline.id);
        if (!current) return;
        appendEvent(pipeline.id, "user_message", { content: message });
        addUserInput(pipeline.id, message);
        clearUserInputRequest(pipeline.id);
        resumePipelineState(pipeline.id);

        const pendingRequirements = current.requirements.filter(
          (r) => r.status === "pending" || r.status === "in_progress"
        );

        if (pendingRequirements.length === 0) {
          return;
        }

        runHarness({
          pipelineId: pipeline.id,
          requirements: pendingRequirements,
          targetProjectPath: current.targetProjectPath || process.cwd(),
          model: "opus",
          maxTurns: 500,
          enablePlaywright: true,
        }).catch((err: Error) => {
          console.error("[API] Resume after user input error:", err);
        });
      } catch (err) {
        console.error("[API] User input handling error:", err);
      }
    }, 0);
    return { ok: true };
  }

  return {
    ok: false,
    status: 400,
    error: "Messages only allowed during QA or when user input is requested",
  };
}

// Send user message during QA phase
app.post("/api/pipelines/:id/message", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
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

  const result = enqueuePipelineMessage(pipeline, message);
  if (!result.ok) {
    return c.json({ error: result.error }, result.status ?? 400);
  }

  return c.json({ ok: true });
});

// Telegram webhook for AskUserQuestion replies
app.post("/api/integrations/telegram/webhook", async (c) => {
  const { webhookSecret } = getTelegramConfig();
  if (webhookSecret) {
    const provided = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (provided !== webhookSecret) {
      return c.json({ ok: false, error: "Unauthorized" }, 401);
    }
  }

  let update: unknown;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const message =
    (update as { message?: { text?: string; caption?: string; chat?: { id?: number } } })
      ?.message ||
    (update as { edited_message?: { text?: string; caption?: string; chat?: { id?: number } } })
      ?.edited_message;

  const text = message?.text || message?.caption;
  const chatId = message?.chat?.id;

  if (!text || !chatId) {
    return c.json({ ok: true });
  }

  if (!isTelegramChatAllowed(chatId)) {
    return c.json({ ok: true });
  }

  const activePipelineId = getActivePipelineId();
  if (!activePipelineId) {
    return c.json({ ok: true });
  }

  const pipeline = getPipeline(activePipelineId);
  if (!pipeline) {
    return c.json({ ok: true });
  }

  const result = enqueuePipelineMessage(pipeline, text.trim());
  if (!result.ok) {
    return c.json({ ok: false, error: result.error ?? "Message ignored" });
  }

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
  clearUserInputRequest(pipelineId);

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

  // Use claudeStorageId for centralized artifact storage in backend/.claude/
  const artifactsPrefix = pipeline.featurePrefix || "pipeline";
  const artifacts = await listArtifacts(pipeline.claudeStorageId, artifactsPrefix);
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

  // Use claudeStorageId for centralized artifact storage in backend/.claude/
  const artifactsPrefix = pipeline.featurePrefix || "pipeline";
  const data = await getArtifact(artifactId, pipeline.claudeStorageId, artifactsPrefix);
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
// User Input API Endpoints (AskUserInput)
// ============================================

// Get pending user input request
app.get("/api/pipelines/:id/user-input/pending", (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  const pendingRequest = getPendingUserInputRequest(pipelineId);
  return c.json({
    hasPending: !!pendingRequest,
    request: pendingRequest || null,
  });
});

// Upload file for a user input field
app.post("/api/pipelines/:id/user-input/upload", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  if (!pipeline.claudeStorageId) {
    return c.json({ error: "Pipeline storage not initialized" }, 400);
  }

  const pendingRequest = getPendingUserInputRequest(pipelineId);
  if (!pendingRequest) {
    return c.json({ error: "No pending user input request" }, 400);
  }

  try {
    const formData = await c.req.formData();
    const fieldId = formData.get("fieldId") as string;
    const file = formData.get("file") as File;

    if (!fieldId || !file) {
      return c.json({ error: "fieldId and file are required" }, 400);
    }

    // Validate that the field exists and is a file field
    const field = pendingRequest.fields.find((f) => f.id === fieldId);
    if (!field) {
      return c.json({ error: `Field ${fieldId} not found in request` }, 400);
    }
    if (field.type !== "file") {
      return c.json({ error: `Field ${fieldId} is not a file field` }, 400);
    }

    // Check file size if maxSizeBytes is specified
    if (field.maxSizeBytes && file.size > field.maxSizeBytes) {
      return c.json({
        error: `File exceeds maximum size of ${Math.round(field.maxSizeBytes / 1024)}KB`,
      }, 400);
    }

    // Check file type if accept is specified
    if (field.accept && field.accept.length > 0) {
      const fileType = file.type;
      const matchesAccept = field.accept.some((pattern) => {
        if (pattern.endsWith("/*")) {
          const prefix = pattern.slice(0, -1);
          return fileType.startsWith(prefix);
        }
        return fileType === pattern;
      });
      if (!matchesAccept) {
        return c.json({
          error: `File type ${fileType} not accepted. Expected: ${field.accept.join(", ")}`,
        }, 400);
      }
    }

    // Store the file
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const fileRef = storeUploadedFile(
      pipeline.claudeStorageId,
      file.name,
      fileBuffer,
      file.type
    );

    console.log(`[API] Uploaded file ${file.name} for field ${fieldId} in pipeline ${pipelineId.slice(0, 8)}`);

    return c.json({
      success: true,
      fileRef,
    });
  } catch (err) {
    console.error("[API] File upload error:", err);
    return c.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      500
    );
  }
});

// Submit user input request schema
const UserInputFieldResponseSchema = z.object({
  fieldId: z.string(),
  value: z.string().optional(),
  fileRef: z.object({
    artifactId: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    storagePath: z.string(),
  }).optional(),
  booleanValue: z.boolean().optional(),
  skipped: z.boolean().optional(),
});

const SubmitUserInputSchema = z.object({
  requestId: z.string(),
  fields: z.array(UserInputFieldResponseSchema),
});

// Submit all user input responses
app.post("/api/pipelines/:id/user-input/submit", async (c) => {
  const pipelineId = c.req.param("id");
  const pipeline = getPipeline(pipelineId);

  if (!pipeline) {
    return c.json({ error: "Pipeline not found" }, 404);
  }

  if (!pipeline.claudeStorageId) {
    return c.json({ error: "Pipeline storage not initialized" }, 400);
  }

  const pendingRequest = getPendingUserInputRequest(pipelineId);
  if (!pendingRequest) {
    return c.json({ error: "No pending user input request" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = SubmitUserInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: "Validation error",
        details: parsed.error.flatten().fieldErrors,
      },
      400
    );
  }

  const { requestId, fields } = parsed.data;

  if (requestId !== pendingRequest.id) {
    return c.json({ error: "Request ID mismatch" }, 400);
  }

  // Validate required fields
  const missingRequired: string[] = [];
  for (const field of pendingRequest.fields) {
    if (field.required) {
      const response = fields.find((f) => f.fieldId === field.id);
      if (!response || response.skipped) {
        missingRequired.push(field.label);
      } else if (field.type === "text" || field.type === "secret") {
        if (!response.value || response.value.trim() === "") {
          missingRequired.push(field.label);
        }
      } else if (field.type === "file") {
        if (!response.fileRef) {
          missingRequired.push(field.label);
        }
      } else if (field.type === "boolean") {
        if (response.booleanValue === undefined) {
          missingRequired.push(field.label);
        }
      }
    }
  }

  if (missingRequired.length > 0) {
    return c.json({
      error: `Missing required fields: ${missingRequired.join(", ")}`,
    }, 400);
  }

  // Process and store secrets
  for (const fieldResponse of fields) {
    const fieldDef = pendingRequest.fields.find((f) => f.id === fieldResponse.fieldId);
    if (!fieldDef) continue;

    if (fieldDef.type === "secret" && fieldResponse.value) {
      const secretField = fieldDef as SecretInputField;
      storeSecretToEnv(
        pipeline.claudeStorageId,
        secretField.envVarName,
        fieldResponse.value
      );
    }
  }

  // Create the response object
  const response: AskUserInputResponse = {
    requestId,
    fields: fields as UserInputFieldResponse[],
    respondedAt: new Date().toISOString(),
  };

  // Add the response and clear the pending request
  addUserInputResponse(pipelineId, response);

  // Emit an event for the response
  appendEvent(pipelineId, "user_message", {
    content: `User input provided for: ${pendingRequest.header}`,
    isUserInput: true,
    fieldCount: fields.length,
  });

  console.log(`[API] User input submitted for pipeline ${pipelineId.slice(0, 8)}: ${fields.length} fields`);

  // Resume the pipeline if it was paused
  resumePipelineState(pipelineId);

  // Get pending requirements and resume with harness if needed
  const current = getPipeline(pipelineId);
  if (current) {
    const pendingRequirements = current.requirements.filter(
      (r) => r.status === "pending" || r.status === "in_progress"
    );

    if (pendingRequirements.length > 0) {
      setTimeout(() => {
        runHarness({
          pipelineId,
          requirements: pendingRequirements,
          targetProjectPath: current.targetProjectPath || process.cwd(),
          model: "opus",
          maxTurns: 500,
          enablePlaywright: true,
        }).catch((err: Error) => {
          console.error("[API] Resume after user input error:", err);
        });
      }, 0);
    }
  }

  return c.json({ ok: true });
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
