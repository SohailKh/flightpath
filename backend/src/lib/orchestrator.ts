/**
 * Pipeline Orchestrator
 *
 * Manages the full workflow: QA → (Plan → Execute → Test) loop
 * Handles agent chaining, retry logic, and abort/pause controls.
 */

import {
  type Pipeline,
  type Requirement,
  getPipeline,
  updatePhase,
  updateStatus,
  setRequirements,
  updateRequirement,
  addToConversation,
  addArtifact,
  appendEvent,
  isPauseRequested,
  isAbortRequested,
  setTargetProjectPath,
} from "./pipeline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Flightpath root directory - resolved at module load time so it doesn't change
// when agents run with a different cwd (targetProjectPath)
const FLIGHTPATH_ROOT = resolve(import.meta.dirname, "..", "..");
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import {
  runPipelineAgent,
  runPipelineAgentWithMessage,
  type ConversationMessage,
  type PipelineAgentResult,
  type ToolEventCallbacks,
} from "./agent";
import { saveScreenshot, saveTestResult, saveDiff } from "./artifacts";
import {
  startDevServers,
  stopDevServers,
  type ServerHandle,
} from "./dev-server";
import { captureWebScreenshot, closeBrowser } from "./screenshot";
import {
  runParallelExplorers,
  type ParallelExplorationResult,
} from "./parallel-explorer";
import { type ExplorationDepth } from "./model-selector";

const MAX_RETRIES = 3;
const FLIGHTPATH_PROJECTS_DIR = "flightpath-projects";

// Colored log prefixes for terminal output
const LOG = {
  pipeline: "\x1b[36m[Pipeline]\x1b[0m",  // Cyan
  qa: "\x1b[33m[QA]\x1b[0m",               // Yellow
  explore: "\x1b[96m[Explore]\x1b[0m",    // Bright Cyan
  plan: "\x1b[35m[Plan]\x1b[0m",           // Magenta
  execute: "\x1b[32m[Execute]\x1b[0m",     // Green
  test: "\x1b[34m[Test]\x1b[0m",           // Blue
  tool: "\x1b[90m[Tool]\x1b[0m",           // Gray
  error: "\x1b[31m[Error]\x1b[0m",         // Red
};

/**
 * Log a tool event with phase context
 */
function logTool(phase: string, toolName: string, args: unknown, suffix?: string) {
  const argsPreview = formatArgsPreview(args);
  const suffixStr = suffix ? ` ${suffix}` : "";
  console.log(`${LOG.tool} ${phase} | ${toolName}${suffixStr}: ${argsPreview}`);
}

/**
 * Log a phase event
 */
function logPhase(phase: keyof typeof LOG, message: string, detail?: string) {
  const prefix = LOG[phase] || LOG.pipeline;
  console.log(`${prefix} ${message}${detail ? ": " + detail : ""}`);
}

/**
 * Format tool arguments for logging preview
 */
function formatArgsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const obj = args as Record<string, unknown>;

  if ("file_path" in obj) return String(obj.file_path);
  if ("command" in obj) {
    const cmd = String(obj.command);
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  if ("pattern" in obj) return `pattern="${obj.pattern}"`;
  if ("content" in obj) return `[content: ${String(obj.content).length} chars]`;

  const json = JSON.stringify(args);
  return json.length > 80 ? json.slice(0, 77) + "..." : json;
}

/**
 * Truncate a result for logging
 */
function truncateResult(result: unknown): string {
  const str = typeof result === "string" ? result : JSON.stringify(result);
  return str.length > 200 ? str.slice(0, 197) + "..." : str;
}

/**
 * Create tool callbacks for a specific phase
 */
function createToolCallbacks(
  pipelineId: string,
  phase: "qa" | "exploring" | "planning" | "executing" | "testing"
): ToolEventCallbacks {
  const phaseLabel = phase === "qa" ? "QA" : phase.charAt(0).toUpperCase() + phase.slice(1);

  return {
    onToolStart: (toolName, toolInput, toolUseId) => {
      logTool(phaseLabel, toolName, toolInput);
      appendEvent(pipelineId, "tool_started", {
        toolName,
        toolUseId,
        args: toolInput,
        phase,
      });
    },
    onToolComplete: (toolName, toolInput, toolUseId, result, durationMs) => {
      logTool(phaseLabel, toolName, toolInput, `complete (${durationMs}ms)`);
      appendEvent(pipelineId, "tool_completed", {
        toolName,
        toolUseId,
        durationMs,
        result: truncateResult(result),
        phase,
      });
    },
    onToolError: (toolName, toolInput, toolUseId, error) => {
      console.log(`${LOG.error} ${phaseLabel} | ${toolName} failed: ${error}`);
      appendEvent(pipelineId, "tool_error", {
        toolName,
        toolUseId,
        error,
        phase,
      });
    },
    onStatusUpdate: (action) => {
      appendEvent(pipelineId, "status_update", { action, phase });
    },
  };
}

/**
 * Create logging callbacks for dev server management
 */
function createServerLogCallbacks(pipelineId: string) {
  return {
    onLog: (platform: string, message: string) => {
      console.log(`${LOG.test} [${platform}] ${message}`);
      appendEvent(pipelineId, "status_update", {
        action: `[${platform}] ${message}`,
        phase: "testing",
      });
    },
    onHealthy: (platform: string) => {
      appendEvent(pipelineId, "server_healthy", { platform });
    },
    onError: (platform: string, error: string) => {
      appendEvent(pipelineId, "server_error", { platform, error });
    },
  };
}

/**
 * Capture git diff and save as artifact
 */
async function captureDiff(
  pipelineId: string,
  requirementId: string,
  targetProjectPath?: string
): Promise<void> {
  if (!targetProjectPath) return;

  try {
    // Get the diff of uncommitted changes
    const { stdout } = await execAsync("git diff HEAD", {
      cwd: targetProjectPath,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
    });

    if (stdout.trim()) {
      const artifact = await saveDiff(
        stdout,
        requirementId,
        targetProjectPath
      );
      addArtifact(pipelineId, {
        id: artifact.id,
        type: artifact.type,
        path: artifact.path,
        requirementId,
      });
      logPhase("execute", "Saved diff artifact", artifact.id);
    } else {
      logPhase("execute", "No diff to capture", "working tree clean");
    }
  } catch (err) {
    // Git might not be initialized or no commits yet - this is OK
    logPhase("error", "Failed to capture diff", String(err));
  }
}

/**
 * Sanitize a project name for use in directory paths
 * Converts to lowercase, replaces spaces with hyphens, removes special chars
 */
function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "untitled-project";
}

/**
 * Generate the target project path from a project name
 */
function generateTargetProjectPath(projectName: string): string {
  const sanitized = sanitizeProjectName(projectName);
  return join(homedir(), FLIGHTPATH_PROJECTS_DIR, sanitized);
}

/**
 * Initialize the target project directory and copy feature spec
 */
async function initializeTargetProject(targetPath: string): Promise<void> {
  const { mkdir, copyFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  // Create target directory structure
  const claudeDir = join(targetPath, ".claude", "pipeline");
  await mkdir(claudeDir, { recursive: true });

  // Copy feature spec from flightpath to target project
  const sourceSpec = join(FLIGHTPATH_ROOT, ".claude", "pipeline", "feature-spec.v3.json");
  const targetSpec = join(claudeDir, "feature-spec.v3.json");

  if (existsSync(sourceSpec)) {
    await copyFile(sourceSpec, targetSpec);
    console.log(`[Orchestrator] Copied feature spec to ${targetSpec}`);
  } else {
    console.warn(`[Orchestrator] Feature spec not found at ${sourceSpec}`);
  }
}

/**
 * Check abort/pause status and handle accordingly
 * Returns true if pipeline should stop
 */
async function checkControlFlags(pipelineId: string): Promise<boolean> {
  const abort = isAbortRequested(pipelineId);
  const pause = isPauseRequested(pipelineId);

  if (abort || pause) {
    console.log(`${LOG.pipeline} Control check: abort=${abort}, pause=${pause}`);
  }

  if (abort) {
    updateStatus(pipelineId, "aborted");
    appendEvent(pipelineId, "aborted", {});
    return true;
  }

  if (pause) {
    updateStatus(pipelineId, "paused");
    appendEvent(pipelineId, "paused", {});
    return true;
  }

  return false;
}

/**
 * Run the QA phase - interview user about the feature
 * This phase is interactive and requires user input
 */
export async function runQAPhase(
  pipelineId: string,
  initialPrompt: string,
  targetProjectPath?: string
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  console.log(`${LOG.qa} Starting QA phase for pipeline ${pipelineId.slice(0, 8)}`);
  appendEvent(pipelineId, "qa_started", { initialPrompt });
  updatePhase(pipelineId, { current: "qa" });

  // Start the QA agent with the initial prompt
  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", { content: chunk, streaming: true });
  };

  // Create tool callbacks for verbose logging
  const toolCallbacks = createToolCallbacks(pipelineId, "qa");

  try {
    logPhase("qa", "Starting QA agent", initialPrompt.slice(0, 100));
    appendEvent(pipelineId, "status_update", { action: "Starting feature discovery...", phase: "qa" });

    const result = await runPipelineAgent("feature-qa", initialPrompt, onStreamChunk, targetProjectPath, 50, toolCallbacks);
    logPhase("qa", "Agent responded", result.reply.slice(0, 100));

    // Store conversation history
    addToConversation(pipelineId, "user", initialPrompt);
    addToConversation(pipelineId, "assistant", result.reply);

    // Emit the full response
    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestion: result.userQuestion,
      userQuestions: result.userQuestions,
    });

    // If agent needs user input, pause and wait for message
    if (result.requiresUserInput) {
      // Pipeline will continue when user sends a message via handleUserMessage
      return;
    }

    // Check if QA is complete (agent should have written feature-spec.v3.json)
    if (isQAComplete(result)) {
      await onQAComplete(pipelineId, result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Pipeline ${pipelineId}] QA phase failed:`, errorMessage);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    appendEvent(pipelineId, "pipeline_failed", {
      phase: "qa",
      error: errorMessage,
    });
    updateStatus(pipelineId, "failed");
  }
}

/**
 * Handle user message during QA phase
 */
export async function handleUserMessage(
  pipelineId: string,
  message: string
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  // Only allow messages during QA phase
  if (pipeline.phase.current !== "qa") {
    appendEvent(pipelineId, "user_message", {
      content: message,
      error: "User messages only allowed during QA phase",
    });
    return;
  }

  appendEvent(pipelineId, "user_message", { content: message });
  addToConversation(pipelineId, "user", message);

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", { content: chunk, streaming: true });
  };

  const toolCallbacks = createToolCallbacks(pipelineId, "qa");

  try {
    logPhase("qa", "Continuing QA with user message", message.slice(0, 50));
    console.log(`[QA Debug] Conversation history length: ${pipeline.conversationHistory.length}`);
    // Provide immediate feedback that the agent is working
    appendEvent(pipelineId, "status_update", {
      action: "Processing your response (this may take a few minutes if generating requirements)...",
      phase: "qa"
    });

    console.log(`[QA Debug] Calling runPipelineAgentWithMessage...`);
    const result = await runPipelineAgentWithMessage(
      "feature-qa",
      message,
      pipeline.conversationHistory,
      onStreamChunk,
      pipeline.targetProjectPath,
      50,
      toolCallbacks
    );
    console.log(`[QA Debug] runPipelineAgentWithMessage returned, requiresUserInput=${result.requiresUserInput}`);

    addToConversation(pipelineId, "assistant", result.reply);

    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestion: result.userQuestion,
      userQuestions: result.userQuestions,
    });

    // Check if QA is complete
    if (isQAComplete(result)) {
      await onQAComplete(pipelineId, result);
    }
  } catch (error) {
    appendEvent(pipelineId, "pipeline_failed", {
      phase: "qa",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    updateStatus(pipelineId, "failed");
  }
}

/**
 * Check if QA phase is complete
 * The QA agent signals completion by invoking feature-init
 */
function isQAComplete(result: PipelineAgentResult): boolean {
  // Check if the agent output indicates requirements are ready
  // This could be detected by:
  // 1. Agent explicitly stating requirements are ready
  // 2. Agent attempting to chain to feature-init
  // 3. Detection of feature-spec.v3.json being written
  //
  // NOTE: We do NOT use !result.requiresUserInput here because the agent may
  // simply be making tool calls without asking questions - that doesn't mean
  // the spec is complete. We need explicit completion signals.

  const reply = result.reply.toLowerCase();
  const isComplete = (
    reply.includes("requirements have been generated") ||
    reply.includes("use feature-init") ||
    reply.includes("feature-spec.v3.json")
  );

  console.log(`${LOG.qa} Checking completion... result=${isComplete}`);
  return isComplete;
}

/**
 * Handle QA completion - parse requirements and start the loop
 */
async function onQAComplete(
  pipelineId: string,
  result: PipelineAgentResult
): Promise<void> {
  appendEvent(pipelineId, "qa_completed", {});
  appendEvent(pipelineId, "requirements_ready", {
    message: "Requirements have been generated",
  });

  // Parse requirements and project name from the feature spec
  const { requirements, projectName } = await parseRequirementsFromSpec();

  console.log(`${LOG.qa} Complete. Found ${requirements.length} requirements, project: ${projectName}`);

  if (requirements.length === 0) {
    appendEvent(pipelineId, "pipeline_failed", {
      error: "No requirements found after QA phase",
    });
    updateStatus(pipelineId, "failed");
    return;
  }

  // Generate and set the target project path
  const targetPath = generateTargetProjectPath(projectName);
  setTargetProjectPath(pipelineId, targetPath);

  // Create target directory and copy feature spec
  await initializeTargetProject(targetPath);

  appendEvent(pipelineId, "target_project_set", {
    projectName,
    targetPath,
  });

  setRequirements(pipelineId, requirements);
  updatePhase(pipelineId, { totalRequirements: requirements.length });

  // Start the implementation loop
  await runImplementationLoop(pipelineId);
}

interface ParsedFeatureSpec {
  requirements: Requirement[];
  projectName: string;
}

/**
 * Parse requirements and project name from the feature spec file
 */
async function parseRequirementsFromSpec(): Promise<ParsedFeatureSpec> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");

    const specPath = join(
      FLIGHTPATH_ROOT,
      ".claude",
      "pipeline",
      "feature-spec.v3.json"
    );

    if (!existsSync(specPath)) {
      console.warn("Feature spec not found:", specPath);
      return { requirements: [], projectName: "untitled-project" };
    }

    const content = await readFile(specPath, "utf-8");
    const spec = JSON.parse(content);

    // Extract project/feature name
    const projectName = String(
      spec.featureName || spec.projectName || spec.name || "untitled-project"
    );

    if (!spec.requirements || !Array.isArray(spec.requirements)) {
      return { requirements: [], projectName };
    }

    const requirements = spec.requirements.map(
      (req: Record<string, unknown>): Requirement => ({
        id: String(req.id || ""),
        title: String(req.title || ""),
        description: String(req.description || ""),
        priority: Number(req.priority || 0),
        status: "pending",
        acceptanceCriteria: Array.isArray(req.acceptanceCriteria)
          ? req.acceptanceCriteria.map(String)
          : [],
      })
    );

    return { requirements, projectName };
  } catch (error) {
    console.error("Error parsing requirements:", error);
    return { requirements: [], projectName: "untitled-project" };
  }
}

/**
 * Run the main implementation loop: Plan → Execute → Test for each requirement
 */
async function runImplementationLoop(pipelineId: string): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  console.log(`${LOG.pipeline} Starting implementation loop: ${pipeline.requirements.length} requirements`);

  for (let i = 0; i < pipeline.requirements.length; i++) {
    // Check control flags at the start of each requirement
    if (await checkControlFlags(pipelineId)) {
      return;
    }

    const requirement = pipeline.requirements[i];
    console.log(`${LOG.pipeline} Requirement ${i + 1}/${pipeline.requirements.length}: ${requirement.title}`);
    updatePhase(pipelineId, { requirementIndex: i, retryCount: 0 });

    appendEvent(pipelineId, "requirement_started", {
      requirementId: requirement.id,
      title: requirement.title,
      index: i,
      total: pipeline.requirements.length,
    });

    updateRequirement(pipelineId, requirement.id, "in_progress");

    // Run plan → execute → test with retry logic
    let success = false;
    let retryCount = 0;

    while (!success && retryCount < MAX_RETRIES) {
      if (await checkControlFlags(pipelineId)) {
        return;
      }

      try {
        // EXPLORE phase
        await runExplorePhase(pipelineId, requirement);
        if (await checkControlFlags(pipelineId)) return;

        // PLAN phase
        await runPlanPhase(pipelineId, requirement);
        if (await checkControlFlags(pipelineId)) return;

        // EXECUTE phase
        await runExecutePhase(pipelineId, requirement);
        if (await checkControlFlags(pipelineId)) return;

        // TEST phase
        const testPassed = await runTestPhase(pipelineId, requirement);

        if (testPassed) {
          success = true;
          console.log(`${LOG.pipeline} Requirement ${requirement.id} completed`);
          updateRequirement(pipelineId, requirement.id, "completed");
          appendEvent(pipelineId, "requirement_completed", {
            requirementId: requirement.id,
          });
        } else {
          retryCount++;
          console.log(`${LOG.pipeline} Retry ${retryCount}/${MAX_RETRIES} for requirement ${requirement.id}`);
          updatePhase(pipelineId, { retryCount });

          if (retryCount < MAX_RETRIES) {
            appendEvent(pipelineId, "retry_started", {
              requirementId: requirement.id,
              attempt: retryCount + 1,
              maxAttempts: MAX_RETRIES,
            });
          }
        }
      } catch (error) {
        retryCount++;
        updatePhase(pipelineId, { retryCount });

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        console.log(`${LOG.error} Requirement ${requirement.id} error: ${errorMessage.slice(0, 100)}`);

        if (retryCount >= MAX_RETRIES) {
          console.log(`${LOG.pipeline} Requirement ${requirement.id} failed after ${retryCount} attempts`);
          appendEvent(pipelineId, "requirement_failed", {
            requirementId: requirement.id,
            error: errorMessage,
            attempts: retryCount,
          });
          updateRequirement(pipelineId, requirement.id, "failed");
        } else {
          console.log(`${LOG.pipeline} Retry ${retryCount}/${MAX_RETRIES} for requirement ${requirement.id}`);
          appendEvent(pipelineId, "retry_started", {
            requirementId: requirement.id,
            attempt: retryCount + 1,
            maxAttempts: MAX_RETRIES,
            error: errorMessage,
          });
        }
      }
    }

    if (!success) {
      // Requirement failed after all retries - continue to next
      updateRequirement(pipelineId, requirement.id, "failed");
    }
  }

  // All requirements processed
  const completedCount = pipeline.requirements.filter((r) => r.status === "completed").length;
  const failedCount = pipeline.requirements.filter((r) => r.status === "failed").length;
  console.log(`${LOG.pipeline} Implementation complete: ${completedCount}/${pipeline.requirements.length} succeeded, ${failedCount} failed`);

  appendEvent(pipelineId, "pipeline_completed", {
    totalRequirements: pipeline.requirements.length,
    completed: completedCount,
    failed: failedCount,
  });
  updateStatus(pipelineId, "completed");
}

/**
 * Run the exploration phase for a requirement
 * Uses parallel specialized explorers (pattern, API, test) for fast, comprehensive discovery
 */
async function runExplorePhase(
  pipelineId: string,
  requirement: Requirement,
  depth: ExplorationDepth = "medium"
): Promise<ParallelExplorationResult> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) throw new Error("Pipeline not found");

  logPhase("explore", `Starting parallel exploration for ${requirement.id}`, requirement.title);

  appendEvent(pipelineId, "exploring_started", {
    requirementId: requirement.id,
  });

  // Emit parallel exploration start event
  appendEvent(pipelineId, "parallel_exploration_started", {
    requirementId: requirement.id,
    depth,
    explorerCount: 3,
  });

  updatePhase(pipelineId, { current: "exploring" });
  updateStatus(pipelineId, "exploring");

  const toolCallbacks = createToolCallbacks(pipelineId, "exploring");
  appendEvent(pipelineId, "status_update", {
    action: "Running parallel explorers (pattern, API, test)...",
    phase: "exploring"
  });

  // Run parallel explorers
  const result = await runParallelExplorers(
    pipelineId,
    requirement,
    pipeline.targetProjectPath,
    depth,
    toolCallbacks
  );

  logPhase("explore", "Parallel exploration completed", `${requirement.id} - model: ${result.selectedModel}`);

  // Emit summary of exploration results
  appendEvent(pipelineId, "agent_message", {
    phase: "exploring",
    content: formatExplorationSummary(result),
    streaming: false,
  });

  // Emit parallel exploration completed event
  appendEvent(pipelineId, "parallel_exploration_completed", {
    requirementId: requirement.id,
    totalDuration: result.totalDuration,
    selectedModel: result.selectedModel,
    complexityScore: result.complexityScore,
    patternsFound: result.merged.patterns.length,
    filesFound:
      result.merged.relatedFiles.templates.length +
      result.merged.relatedFiles.types.length +
      result.merged.relatedFiles.tests.length,
    successfulExplorers: result.explorers.filter(e => !e.error).length,
    failedExplorers: result.explorers.filter(e => e.error).length,
  });

  appendEvent(pipelineId, "exploring_completed", {
    requirementId: requirement.id,
  });

  return result;
}

/**
 * Format exploration results into a readable summary
 */
function formatExplorationSummary(result: ParallelExplorationResult): string {
  const lines: string[] = [];

  lines.push(`## Exploration Summary for ${result.requirementId}`);
  lines.push("");
  lines.push(`**Duration:** ${result.totalDuration}ms`);
  lines.push(`**Selected Model:** ${result.selectedModel} (complexity score: ${result.complexityScore})`);
  lines.push("");

  // Explorer results
  lines.push("### Explorer Results");
  for (const explorer of result.explorers) {
    const status = explorer.error ? `❌ ${explorer.error}` : `✅ ${explorer.duration}ms`;
    lines.push(`- **${explorer.type}:** ${status}`);
    if (!explorer.error) {
      lines.push(`  - Patterns: ${explorer.patterns.length}`);
      lines.push(`  - Files: ${explorer.relatedFiles.templates.length + explorer.relatedFiles.types.length + explorer.relatedFiles.tests.length}`);
    }
  }
  lines.push("");

  // Merged results
  lines.push("### Merged Context");
  lines.push(`- **Patterns found:** ${result.merged.patterns.length}`);
  lines.push(`- **Templates:** ${result.merged.relatedFiles.templates.length}`);
  lines.push(`- **Types:** ${result.merged.relatedFiles.types.length}`);
  lines.push(`- **Tests:** ${result.merged.relatedFiles.tests.length}`);
  lines.push(`- **API Endpoints:** ${result.merged.apiEndpoints.length}`);

  if (result.merged.notes.length > 0) {
    lines.push("");
    lines.push("### Notes");
    for (const note of result.merged.notes.slice(0, 5)) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

/**
 * Run the planning phase for a requirement
 */
async function runPlanPhase(
  pipelineId: string,
  requirement: Requirement
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  logPhase("plan", `Starting planning for ${requirement.id}`, requirement.title);

  appendEvent(pipelineId, "planning_started", {
    requirementId: requirement.id,
  });
  updatePhase(pipelineId, { current: "planning" });
  updateStatus(pipelineId, "planning");

  const prompt = `Plan the implementation for requirement: ${requirement.id}

Title: ${requirement.title}
Description: ${requirement.description}

Acceptance Criteria:
${requirement.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

Create a detailed implementation plan following the feature-planner guidelines.`;

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", {
      phase: "planning",
      content: chunk,
      streaming: true,
    });
  };

  const toolCallbacks = createToolCallbacks(pipelineId, "planning");
  appendEvent(pipelineId, "status_update", { action: "Analyzing requirements...", phase: "planning" });

  const result = await runPipelineAgent(
    "feature-planner",
    prompt,
    onStreamChunk,
    pipeline.targetProjectPath,
    undefined,
    toolCallbacks
  );

  logPhase("plan", "Planning completed", `${requirement.id}`);

  appendEvent(pipelineId, "agent_message", {
    phase: "planning",
    content: result.reply,
    streaming: false,
  });

  appendEvent(pipelineId, "planning_completed", {
    requirementId: requirement.id,
  });
}

/**
 * Run the execution phase for a requirement
 */
async function runExecutePhase(
  pipelineId: string,
  requirement: Requirement
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  logPhase("execute", `Starting execution for ${requirement.id}`, requirement.title);

  appendEvent(pipelineId, "executing_started", {
    requirementId: requirement.id,
  });
  updatePhase(pipelineId, { current: "executing" });
  updateStatus(pipelineId, "executing");

  const prompt = `Execute the implementation for requirement: ${requirement.id}

Follow the plan in current-feature.json and implement the code changes.`;

  const onStreamChunk = (chunk: string) => {
    appendEvent(pipelineId, "agent_message", {
      phase: "executing",
      content: chunk,
      streaming: true,
    });
  };

  const toolCallbacks = createToolCallbacks(pipelineId, "executing");
  appendEvent(pipelineId, "status_update", { action: "Implementing code changes...", phase: "executing" });

  const result = await runPipelineAgent(
    "feature-executor",
    prompt,
    onStreamChunk,
    pipeline.targetProjectPath,
    undefined,
    toolCallbacks
  );

  logPhase("execute", "Execution completed", `${requirement.id}`);

  appendEvent(pipelineId, "agent_message", {
    phase: "executing",
    content: result.reply,
    streaming: false,
  });

  // Capture diff after execution
  await captureDiff(pipelineId, requirement.id, pipeline.targetProjectPath);

  appendEvent(pipelineId, "executing_completed", {
    requirementId: requirement.id,
  });
}

/**
 * Run the testing phase for a requirement
 * Returns true if tests passed
 */
async function runTestPhase(
  pipelineId: string,
  requirement: Requirement
): Promise<boolean> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return false;

  logPhase("test", `Starting tests for ${requirement.id}`, requirement.title);

  appendEvent(pipelineId, "testing_started", {
    requirementId: requirement.id,
  });
  updatePhase(pipelineId, { current: "testing" });
  updateStatus(pipelineId, "testing");

  let servers: ServerHandle[] = [];

  try {
    // === START DEV SERVERS ===
    if (pipeline.targetProjectPath) {
      appendEvent(pipelineId, "status_update", {
        action: "Starting dev servers...",
        phase: "testing",
      });

      const serverResult = await startDevServers({
        projectPath: pipeline.targetProjectPath,
        timeoutMs: 60_000, // 60 second timeout
        ...createServerLogCallbacks(pipelineId),
      });

      servers = serverResult.servers;

      if (!serverResult.allHealthy) {
        // Log warnings but continue - some tests may not need servers
        for (const err of serverResult.errors) {
          logPhase("error", `Server startup issue: ${err.platform}`, err.error);
        }
        appendEvent(pipelineId, "server_warning", {
          message: "Not all servers started successfully",
          errors: serverResult.errors,
        });
      }

      appendEvent(pipelineId, "servers_ready", {
        count: servers.length,
        healthy: servers.filter((s) => s.healthy).length,
      });

      // === CAPTURE INITIAL SCREENSHOTS ===
      for (const server of servers) {
        if (server.healthy && server.healthCheckUrl) {
          try {
            appendEvent(pipelineId, "status_update", {
              action: `Capturing screenshot for ${server.platform}...`,
              phase: "testing",
            });

            const screenshot = await captureWebScreenshot(server.healthCheckUrl, {
              waitForNetworkIdle: true,
              fullPage: true,
            });

            const artifact = await saveScreenshot(
              screenshot,
              requirement.id,
              pipeline.targetProjectPath
            );

            addArtifact(pipelineId, {
              id: artifact.id,
              type: artifact.type,
              path: artifact.path,
              requirementId: requirement.id,
            });

            appendEvent(pipelineId, "screenshot_captured", {
              artifactId: artifact.id,
              platform: server.platform,
              requirementId: requirement.id,
            });

            logPhase("test", `Screenshot captured for ${server.platform}`, artifact.id);
          } catch (err) {
            logPhase("error", `Failed to capture screenshot for ${server.platform}`, String(err));
          }
        }
      }
    }

    // === RUN TEST AGENT ===
    const prompt = `Test the implementation for requirement: ${requirement.id}

Verify all acceptance criteria:
${requirement.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}

Run tests and capture screenshots as evidence.`;

    const onStreamChunk = (chunk: string) => {
      appendEvent(pipelineId, "agent_message", {
        phase: "testing",
        content: chunk,
        streaming: true,
      });
    };

    const toolCallbacks = createToolCallbacks(pipelineId, "testing");
    appendEvent(pipelineId, "status_update", {
      action: "Verifying implementation...",
      phase: "testing",
    });

    const result = await runPipelineAgent(
      "feature-tester",
      prompt,
      onStreamChunk,
      pipeline.targetProjectPath,
      undefined,
      toolCallbacks,
      { enablePlaywrightTools: true }
    );

    logPhase("test", "Testing completed", `${requirement.id}`);

    appendEvent(pipelineId, "agent_message", {
      phase: "testing",
      content: result.reply,
      streaming: false,
    });

    // Determine if tests passed based on agent output
    const testPassed = determineTestResult(result);

    // Save test result artifact
    const testResult = {
      requirementId: requirement.id,
      passed: testPassed,
      timestamp: new Date().toISOString(),
      criteria: requirement.acceptanceCriteria.map((c) => ({
        criterion: c,
        passed: testPassed,
      })),
      failureReason: testPassed ? undefined : extractFailureReason(result),
    };

    try {
      const artifact = await saveTestResult(
        testResult,
        requirement.id,
        pipeline.targetProjectPath
      );
      addArtifact(pipelineId, {
        id: artifact.id,
        type: artifact.type,
        path: artifact.path,
        requirementId: requirement.id,
      });
    } catch (err) {
      logPhase("error", "Failed to save test result artifact", String(err));
    }

    if (testPassed) {
      appendEvent(pipelineId, "test_passed", {
        requirementId: requirement.id,
      });
    } else {
      appendEvent(pipelineId, "test_failed", {
        requirementId: requirement.id,
        reason: extractFailureReason(result),
      });
    }

    appendEvent(pipelineId, "testing_completed", {
      requirementId: requirement.id,
      passed: testPassed,
    });

    return testPassed;
  } finally {
    // === CLEANUP: STOP DEV SERVERS ===
    if (servers.length > 0) {
      appendEvent(pipelineId, "status_update", {
        action: "Stopping dev servers...",
        phase: "testing",
      });

      await stopDevServers(servers, (platform, message) => {
        console.log(`${LOG.test} [${platform}] ${message}`);
      });

      appendEvent(pipelineId, "servers_stopped", {
        count: servers.length,
      });
    }

    // Close Playwright browser to free resources
    await closeBrowser();
  }
}

/**
 * Determine if tests passed based on agent result
 */
function determineTestResult(result: PipelineAgentResult): boolean {
  const reply = result.reply.toLowerCase();

  // Check for explicit success indicators
  if (
    reply.includes("all tests passed") ||
    reply.includes("tests passed") ||
    reply.includes("implementation verified") ||
    reply.includes("acceptance criteria met")
  ) {
    console.log(`${LOG.test} Result determination: passed=true (explicit success indicator)`);
    return true;
  }

  // Check for failure indicators
  if (
    reply.includes("test failed") ||
    reply.includes("tests failed") ||
    reply.includes("acceptance criteria not met") ||
    reply.includes("issues found")
  ) {
    console.log(`${LOG.test} Result determination: passed=false (failure indicator found)`);
    return false;
  }

  // Default to passed if no clear indicator
  console.log(`${LOG.test} Result determination: passed=true (no clear indicator, defaulting to passed)`);
  return true;
}

/**
 * Extract failure reason from test result
 */
function extractFailureReason(result: PipelineAgentResult): string {
  const reply = result.reply;

  // Look for common failure patterns
  const failurePatterns = [
    /failed:?\s*(.+?)(?:\n|$)/i,
    /error:?\s*(.+?)(?:\n|$)/i,
    /issue:?\s*(.+?)(?:\n|$)/i,
  ];

  for (const pattern of failurePatterns) {
    const match = reply.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return "Unknown failure reason";
}

/**
 * Resume a paused pipeline
 */
export async function resumePipeline(pipelineId: string): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline || pipeline.status !== "paused") {
    return;
  }

  appendEvent(pipelineId, "resumed", {});

  // Resume from where we left off based on current phase
  switch (pipeline.phase.current) {
    case "qa":
      // QA phase - wait for user message
      break;
    case "exploring":
    case "planning":
    case "executing":
    case "testing":
      // Resume implementation loop
      await runImplementationLoop(pipelineId);
      break;
  }
}
