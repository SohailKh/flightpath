import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  addCompletedRequirement,
  addFailedRequirement,
  appendEvent,
  getPipeline,
  updateRequirement,
  type Requirement,
} from "../pipeline";
import type { EventBridge } from "./event-bridge";
import {
  readRequirementsSnapshot,
  writeRequirementsSnapshot,
} from "./requirements-store";

const TOOL_RESULT_OK = (message: string, structuredContent?: Record<string, unknown>) => ({
  content: [{ type: "text", text: message }],
  ...(structuredContent ? { structuredContent } : {}),
});

function normalizeStatus(status?: string): Requirement["status"] | undefined {
  if (!status) return undefined;
  if (status === "done" || status === "completed") return "completed";
  if (status === "pending" || status === "in_progress" || status === "failed") {
    return status;
  }
  return undefined;
}

function emitWorkflowEvent(
  pipelineId: string,
  toolName: string,
  input: Record<string, unknown>,
  eventBridge?: EventBridge
): void {
  if (eventBridge) {
    eventBridge.onWorkflowTool(toolName, input);
    return;
  }

  switch (toolName) {
    case "start_requirement":
      appendEvent(pipelineId, "requirement_started", { requirementId: input.id });
      break;
    case "complete_requirement":
      appendEvent(pipelineId, "requirement_completed", { requirementId: input.id });
      break;
    case "fail_requirement":
      appendEvent(pipelineId, "requirement_failed", {
        requirementId: input.id,
        reason: input.reason,
      });
      break;
    case "update_status":
      appendEvent(pipelineId, "status_update", {
        action: String(input.note || "Working..."),
        requirementId: input.id,
        requirementStatus: input.status,
        statusSource: "workflow",
      });
      break;
    case "log_progress":
      appendEvent(pipelineId, "status_update", {
        action: String(input.message || "Progress update"),
        requirementId: input.requirementId,
        level: input.level,
        statusSource: "workflow",
      });
      break;
  }
}

function selectRequirements(
  requirements: Requirement[],
  ids?: string[],
  status?: string
): Requirement[] {
  let results = requirements;
  if (ids && ids.length > 0) {
    const idSet = new Set(ids);
    results = results.filter((req) => idSet.has(req.id));
  }
  const normalized = normalizeStatus(status);
  if (normalized) {
    results = results.filter((req) => req.status === normalized);
  }
  return results;
}

export function createWorkflowMcpServer(
  pipelineId: string,
  eventBridge?: EventBridge
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "workflow",
    version: "1.0.0",
    tools: [
      tool(
        "start_requirement",
        "Mark a requirement as started (in_progress).",
        { id: z.string() },
        async (args) => {
          updateRequirement(pipelineId, args.id, "in_progress");
          emitWorkflowEvent(pipelineId, "start_requirement", args, eventBridge);
          await writeRequirementsSnapshot(pipelineId);
          return TOOL_RESULT_OK(`Started requirement ${args.id}.`);
        }
      ),
      tool(
        "update_status",
        "Update a requirement status with an optional note.",
        {
          id: z.string(),
          status: z.enum(["pending", "in_progress", "done", "failed"]),
          note: z.string().optional(),
        },
        async (args) => {
          const normalized = normalizeStatus(args.status);
          if (normalized) {
            updateRequirement(pipelineId, args.id, normalized);
            if (normalized === "completed") {
              addCompletedRequirement(pipelineId, args.id);
            } else if (normalized === "failed") {
              addFailedRequirement(pipelineId, args.id);
            }
          }
          emitWorkflowEvent(pipelineId, "update_status", args, eventBridge);
          await writeRequirementsSnapshot(pipelineId);
          return TOOL_RESULT_OK(`Updated requirement ${args.id} status.`);
        }
      ),
      tool(
        "complete_requirement",
        "Mark a requirement as completed.",
        { id: z.string(), note: z.string().optional() },
        async (args) => {
          updateRequirement(pipelineId, args.id, "completed");
          addCompletedRequirement(pipelineId, args.id);
          emitWorkflowEvent(pipelineId, "complete_requirement", args, eventBridge);
          await writeRequirementsSnapshot(pipelineId);
          return TOOL_RESULT_OK(`Completed requirement ${args.id}.`);
        }
      ),
      tool(
        "fail_requirement",
        "Mark a requirement as failed with a reason.",
        { id: z.string(), reason: z.string() },
        async (args) => {
          updateRequirement(pipelineId, args.id, "failed");
          addFailedRequirement(pipelineId, args.id);
          emitWorkflowEvent(pipelineId, "fail_requirement", args, eventBridge);
          await writeRequirementsSnapshot(pipelineId);
          return TOOL_RESULT_OK(`Failed requirement ${args.id}.`, {
            reason: args.reason,
          });
        }
      ),
      tool(
        "log_progress",
        "Log a progress update for the current work.",
        {
          message: z.string(),
          level: z.enum(["info", "warn", "error"]).optional(),
          requirementId: z.string().optional(),
        },
        async (args) => {
          emitWorkflowEvent(pipelineId, "log_progress", args, eventBridge);
          await writeRequirementsSnapshot(pipelineId);
          return TOOL_RESULT_OK("Progress logged.");
        }
      ),
      tool(
        "get_requirements",
        "Fetch requirements with optional filtering.",
        {
          ids: z.array(z.string()).optional(),
          status: z.string().optional(),
          includeDetails: z.boolean().optional(),
        },
        async (args) => {
          const pipeline = getPipeline(pipelineId);
          const snapshot = pipeline
            ? null
            : await readRequirementsSnapshot(pipelineId);
          const requirements = pipeline?.requirements ?? snapshot?.requirements ?? [];

          const selected = selectRequirements(
            requirements,
            args.ids,
            args.status
          );
          const includeDetails = args.includeDetails ?? false;

          const payload = includeDetails
            ? selected
            : selected.map((req) => ({
                id: req.id,
                title: req.title,
                status: req.status,
                priority: req.priority,
              }));

          const response = {
            requirements: payload,
            total: selected.length,
            includeDetails,
          };

          return TOOL_RESULT_OK(JSON.stringify(response, null, 2), response);
        }
      ),
    ],
  });
}
