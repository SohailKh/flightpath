/**
 * QA Phase (V2 Sessions)
 *
 * Interactive user interview to gather feature requirements.
 * Uses V2 Claude Agent SDK sessions for cleaner multi-turn conversation management.
 */

import { existsSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getPipeline,
  updatePhase,
  updateStatus,
  setRequirements,
  setEpics,
  addToConversation,
  appendEvent,
  setTargetProjectPath,
  setFeaturePrefix,
  setIsNewProject,
  setClaudeStorageId,
  setSessionId,
  getSessionId,
  markRunning,
  markStopped,
} from "../pipeline";
import { generateClaudeStorageId } from "../claude-paths";
import { createV2Session, resumeV2Session, type V2Session, type V2SessionTurnResult } from "../session";
import { createToolCallbacks, emitTodoEvents } from "./callbacks";
import { LOG, logPhase } from "./utils";
import {
  FLIGHTPATH_ROOT,
  parseRequirementsFromSpec,
  generateTargetProjectPath,
  generateStagingProjectPath,
  initializeTargetProject,
  sanitizeProjectName,
} from "./project-init";
import { runHarness } from "../harness";

// Store active sessions in memory (keyed by pipelineId)
const activeSessions = new Map<string, V2Session>();

/**
 * Clear any existing feature spec files to prevent contamination
 * from previous pipelines.
 */
async function clearFeatureSpecs(rootPath?: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");

  const claudeRoot = rootPath ? resolve(rootPath) : FLIGHTPATH_ROOT;
  const claudeDir = join(claudeRoot, ".claude");
  if (!existsSync(claudeDir)) return;

  try {
    const entries = await readdir(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "skills") {
        const specPath = join(claudeDir, entry.name, "feature-spec.v3.json");
        if (existsSync(specPath)) {
          unlinkSync(specPath);
          console.log(`[QA] Cleared stale feature-spec.v3.json from .claude/${entry.name}/`);
        }
      }
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Get or create a V2 session for the pipeline
 */
async function getOrCreateSession(
  pipelineId: string,
  targetProjectPath?: string,
  isNewProject?: boolean,
  claudeStorageId?: string
): Promise<V2Session> {
  // Check if we have an active session in memory
  let session = activeSessions.get(pipelineId);
  if (session) {
    return session;
  }

  // Check if pipeline has a stored session ID (for resume after restart)
  const existingSessionId = getSessionId(pipelineId);

  const toolCallbacks = createToolCallbacks(pipelineId, "qa", "feature-qa");

  if (existingSessionId) {
    // Resume existing session
    console.log(`[QA] Resuming existing session ${existingSessionId.slice(0, 8)}...`);
    session = await resumeV2Session(existingSessionId, {
      agentName: "feature-qa",
      pipelineId,
      targetProjectPath,
      claudeStorageId,
      isNewProject,
      toolCallbacks,
      modelOverride: "opus",
      maxTurns: 50,
    });
    appendEvent(pipelineId, "status_update", {
      action: `Resumed QA session ${existingSessionId.slice(0, 8)}... (cwd: ${
        session.cwd || "default"
      })`,
      phase: "qa",
      statusSource: "system",
    });
  } else {
    // Create new session
    session = await createV2Session({
      agentName: "feature-qa",
      pipelineId,
      targetProjectPath,
      claudeStorageId,
      isNewProject,
      toolCallbacks,
      modelOverride: "opus",
      maxTurns: 50,
    });
    appendEvent(pipelineId, "status_update", {
      action: `Created QA session (cwd: ${session.cwd || "default"})`,
      phase: "qa",
      statusSource: "system",
    });
  }

  activeSessions.set(pipelineId, session);
  return session;
}

/**
 * Process session result and emit events
 */
function processSessionResult(
  pipelineId: string,
  result: V2SessionTurnResult
): void {
  // Store session ID in pipeline for resume capability
  if (result.sessionId) {
    const previousSessionId = getSessionId(pipelineId);
    if (result.sessionId !== previousSessionId) {
      setSessionId(pipelineId, result.sessionId);
      appendEvent(pipelineId, "status_update", {
        action: `Session ID set: ${result.sessionId.slice(0, 8)}...`,
        phase: "qa",
        statusSource: "system",
      });
    }
  }

  if (result.usage) {
    appendEvent(pipelineId, "token_usage", {
      inputTokens: result.usage.input_tokens ?? 0,
      outputTokens: result.usage.output_tokens ?? 0,
      totalTurns: result.totalTurns ?? 0,
      ...(result.totalCostUsd !== undefined && { totalCostUsd: result.totalCostUsd }),
    });
  }

  // Emit todo events if structured output contains todos
  emitTodoEvents(pipelineId, "qa", result.structuredOutput);
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

  let resolvedTargetPath = targetProjectPath || pipeline.targetProjectPath;
  let isNewProject = pipeline.isNewProject ?? false;

  if (!resolvedTargetPath) {
    const { mkdir } = await import("node:fs/promises");
    resolvedTargetPath = generateStagingProjectPath(pipelineId);
    await mkdir(resolvedTargetPath, { recursive: true });
    setTargetProjectPath(pipelineId, resolvedTargetPath);
    setIsNewProject(pipelineId, true);
    isNewProject = true;
  }

  markRunning(pipelineId);

  console.log(`${LOG.qa} Starting QA phase for pipeline ${pipelineId.slice(0, 8)}`);
  if (isNewProject) {
    await clearFeatureSpecs(resolvedTargetPath);
  }
  appendEvent(pipelineId, "qa_started", { initialPrompt });
  updatePhase(pipelineId, { current: "qa" });

  try {
    logPhase("qa", "Starting QA agent (V2 session)", initialPrompt.slice(0, 100));
    appendEvent(pipelineId, "status_update", {
      action: "Starting feature discovery...",
      phase: "qa",
      statusSource: "orchestrator",
    });

    // Get or create V2 session
    const session = await getOrCreateSession(
      pipelineId,
      resolvedTargetPath,
      isNewProject,
      pipeline.claudeStorageId
    );

    // Emit system prompt for debugging
    appendEvent(pipelineId, "agent_prompt", {
      prompt: session.systemPrompt,
      agentName: "feature-qa",
      phase: "qa",
    });

    // Send initial prompt
    const result = await session.send(initialPrompt);

    // Process result
    processSessionResult(pipelineId, result);
    logPhase("qa", "Agent responded", result.reply.slice(0, 100));

    // Store conversation history (for backwards compatibility with existing code)
    addToConversation(pipelineId, "user", initialPrompt);
    addToConversation(pipelineId, "assistant", result.reply);

    // Emit the full response
    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestions: result.userQuestions,
    });

    // If agent needs user input, pause and wait for message
    if (result.requiresUserInput) {
      markStopped(pipelineId);
      return;
    }

    // Check if QA is complete (agent should have written feature-spec.v3.json)
    const completionRoot = session.cwd || resolvedTargetPath;
    if (isQAComplete(result, completionRoot)) {
      markStopped(pipelineId);
      await cleanupSession(pipelineId);
      await onQAComplete(pipelineId, result);
    } else {
      markStopped(pipelineId);
    }
  } catch (error) {
    markStopped(pipelineId);
    await cleanupSession(pipelineId);
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

  markRunning(pipelineId);

  appendEvent(pipelineId, "user_message", { content: message });
  addToConversation(pipelineId, "user", message);

  try {
    logPhase("qa", "Continuing QA with user message (V2 session)", message.slice(0, 50));

    // Count user messages to show progress
    const exchangeCount = pipeline.conversationHistory.filter(m => m.role === "user").length;
    appendEvent(pipelineId, "status_update", {
      action: `Processing response ${exchangeCount} (this may take a few minutes if generating requirements)...`,
      phase: "qa",
      statusSource: "orchestrator",
    });

    // Get existing session (should exist from runQAPhase or previous message)
    const session = await getOrCreateSession(
      pipelineId,
      pipeline.targetProjectPath,
      pipeline.isNewProject ?? false,
      pipeline.claudeStorageId
    );

    // Send message - V2 session automatically maintains conversation history
    console.log(`[QA Debug] Sending message via V2 session...`);
    const result = await session.send(message);
    console.log(`[QA Debug] V2 session.send() returned, requiresUserInput=${result.requiresUserInput}`);

    // Process result
    processSessionResult(pipelineId, result);

    addToConversation(pipelineId, "assistant", result.reply);

    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestions: result.userQuestions,
    });

    // Check if QA is complete
    const completionRoot = session.cwd || pipeline.targetProjectPath;
    if (isQAComplete(result, completionRoot)) {
      markStopped(pipelineId);
      await cleanupSession(pipelineId);
      await onQAComplete(pipelineId, result);
    } else {
      // Waiting for more user input
      markStopped(pipelineId);
    }
  } catch (error) {
    markStopped(pipelineId);
    await cleanupSession(pipelineId);
    appendEvent(pipelineId, "pipeline_failed", {
      phase: "qa",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    updateStatus(pipelineId, "failed");
  }
}

/**
 * Cleanup session resources
 */
async function cleanupSession(pipelineId: string): Promise<void> {
  const session = activeSessions.get(pipelineId);
  if (session) {
    try {
      await session.close();
    } catch {
      // Ignore cleanup errors
    }
    activeSessions.delete(pipelineId);
  }
}

/**
 * Find if any feature spec file exists in .claude/{prefix}/ folders
 */
function findExistingSpecPath(): string | null {
  return findExistingSpecPathAtRoot(FLIGHTPATH_ROOT);
}

function findExistingSpecPathAtRoot(rootPath: string): string | null {
  const claudeDir = join(resolve(rootPath), ".claude");
  if (!existsSync(claudeDir)) return null;

  try {
    const entries = readdirSync(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "skills") {
        const specPath = join(claudeDir, entry.name, "feature-spec.v3.json");
        if (existsSync(specPath)) {
          return specPath;
        }
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Check if QA phase is complete
 * Uses file-based detection for reliability instead of string matching.
 */
function isQAComplete(result: V2SessionTurnResult, rootPath?: string): boolean {
  // Primary: Check if agent wrote to the spec file via tool calls
  const wroteSpecFile = result.toolCalls?.some(
    (call) =>
      call.name === "Write" &&
      String((call.args as Record<string, unknown>)?.file_path || "").includes("feature-spec.v3.json")
  );

  if (wroteSpecFile) {
    console.log(`${LOG.qa} Checking completion... result=true (spec file written by agent)`);
    return true;
  }

  // Fallback: Check actual file existence in any .claude/{prefix}/ folder
  const specPath = rootPath ? findExistingSpecPathAtRoot(rootPath) : findExistingSpecPath();

  if (specPath) {
    console.log(`${LOG.qa} Checking completion... result=true (spec file exists at ${specPath})`);
    return true;
  }

  console.log(`${LOG.qa} Checking completion... result=false (no spec file)`);
  return false;
}

/**
 * Handle QA completion - parse requirements and start the loop
 */
async function onQAComplete(
  pipelineId: string,
  _result: V2SessionTurnResult
): Promise<void> {
  const pipeline = getPipeline(pipelineId);

  appendEvent(pipelineId, "qa_completed", {});
  appendEvent(pipelineId, "requirements_ready", {
    message: "Requirements have been generated",
  });

  // Parse requirements, epics, project name, and feature prefix from the feature spec
  const specRoot = pipeline?.targetProjectPath;
  const { requirements, epics, projectName, featurePrefix } = await parseRequirementsFromSpec(
    specRoot
  );

  console.log(`${LOG.qa} Complete. Found ${requirements.length} requirements, ${epics.length} epics, project: ${projectName}, prefix: ${featurePrefix}`);

  if (requirements.length === 0) {
    appendEvent(pipelineId, "pipeline_failed", {
      error: "No requirements found after QA phase",
    });
    updateStatus(pipelineId, "failed");
    return;
  }

  // Generate and set the unique claudeStorageId for this pipeline
  const sanitizedName = sanitizeProjectName(projectName);
  const claudeStorageId = generateClaudeStorageId(sanitizedName, pipelineId);
  setClaudeStorageId(pipelineId, claudeStorageId);

  if (featurePrefix) {
    setFeaturePrefix(pipelineId, featurePrefix);
  }

  let targetPath = specRoot || generateTargetProjectPath(projectName);
  const desiredPath = generateTargetProjectPath(projectName);

  if (pipeline?.isNewProject && specRoot && specRoot !== desiredPath) {
    try {
      const { rename, mkdir } = await import("node:fs/promises");
      if (!existsSync(desiredPath)) {
        await mkdir(dirname(desiredPath), { recursive: true });
        await rename(specRoot, desiredPath);
        targetPath = desiredPath;
        console.log(`[QA] Moved project directory: ${specRoot} -> ${desiredPath}`);
      } else {
        console.warn(`[QA] Target project path already exists: ${desiredPath}. Keeping ${specRoot}.`);
      }
    } catch (error) {
      console.warn(
        `[QA] Failed to move project directory from ${specRoot} to ${desiredPath}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  } else if (!specRoot) {
    targetPath = desiredPath;
  }

  setTargetProjectPath(pipelineId, targetPath);

  // Create target directory (WITHOUT .claude) and copy feature spec to backend/.claude storage
  await initializeTargetProject(
    targetPath,
    claudeStorageId,
    featurePrefix,
    specRoot,
    pipeline?.isNewProject ?? false
  );

  appendEvent(pipelineId, "target_project_set", {
    projectName,
    targetPath,
  });

  setRequirements(pipelineId, requirements);
  setEpics(pipelineId, epics);
  updatePhase(pipelineId, { totalRequirements: requirements.length });

  // Start the harness with autonomous agent
  await runHarness({
    pipelineId,
    requirements,
    targetProjectPath: targetPath,
    model: "opus",
    maxTurns: 500,
    enablePlaywright: true,
  });
}
