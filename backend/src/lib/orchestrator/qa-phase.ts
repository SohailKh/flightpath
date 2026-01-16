/**
 * QA Phase (V2 Sessions)
 *
 * Interactive user interview to gather feature requirements.
 * Uses V2 Claude Agent SDK sessions for cleaner multi-turn conversation management.
 */

import { existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type Pipeline,
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
  clearSessionId,
  getSessionId,
  updateQAState,
  markRunning,
  markStopped,
} from "../pipeline";
import { CLAUDE_STORAGE_ROOT, generateClaudeStorageId } from "../claude-paths";
import {
  createV2Session,
  resumeV2Session,
  type V2Session,
  type V2SessionTurnResult,
} from "../session";
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
import {
  type FeatureMap,
  type FeatureMapFeature,
  getFeatureMapPath,
  getFeatureSpecPath,
  getPendingFeatures,
  loadFeatureMap,
  selectPrimaryFeature,
} from "./feature-map";
import { runHarness } from "../harness";

// Store active sessions in memory (keyed by pipelineId)
const activeSessions = new Map<string, V2Session>();
const QA_STORAGE_ROOT = CLAUDE_STORAGE_ROOT;
const QA_OUTPUT_ROOT = FLIGHTPATH_ROOT;
const MAX_AUTO_FEATURES = 5;

/**
 * Clear any existing feature spec files to prevent contamination
 * from previous pipelines.
 */
async function clearFeatureSpecs(rootPath?: string, claudeStorageId?: string): Promise<void> {
  const { readdir, rm } = await import("node:fs/promises");

  // If we have a claudeStorageId, clear the project-specific storage folder
  if (claudeStorageId) {
    const projectClaudeDir = join(CLAUDE_STORAGE_ROOT, claudeStorageId);
    if (existsSync(projectClaudeDir)) {
      try {
        await rm(projectClaudeDir, { recursive: true });
        console.log(`[QA] Cleared project-specific .claude folder: ${projectClaudeDir}`);
      } catch (error) {
        console.warn(`[QA] Failed to clear ${projectClaudeDir}:`, error);
      }
    }
  }

  const claudeRoot = rootPath ? resolve(rootPath) : FLIGHTPATH_ROOT;
  const claudeDir = join(claudeRoot, ".claude");
  if (!existsSync(claudeDir)) return;

  // Clear root-level files
  const understandingPath = join(claudeDir, "feature-understanding.json");
  if (existsSync(understandingPath)) {
    unlinkSync(understandingPath);
    console.log("[QA] Cleared stale feature-understanding.json from .claude/");
  }

  const featureMapRootPath = join(claudeDir, "feature-map.json");
  if (existsSync(featureMapRootPath)) {
    unlinkSync(featureMapRootPath);
    console.log("[QA] Cleared stale feature-map.json from .claude/");
  }

  try {
    const entries = await readdir(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "skills") {
        // Clear both new and legacy spec file names
        const specPathNew = join(claudeDir, entry.name, "feature-spec.json");
        const specPathLegacy = join(claudeDir, entry.name, "feature-spec.v3.json");
        const smokePath = join(claudeDir, entry.name, "smoke-tests.json");
        // Legacy: feature-map.json used to be in a feature-map/ subdirectory
        const featureMapLegacyPath =
          entry.name === "feature-map"
            ? join(claudeDir, entry.name, "feature-map.json")
            : null;

        if (existsSync(specPathNew)) {
          unlinkSync(specPathNew);
          console.log(`[QA] Cleared stale feature-spec.json from .claude/${entry.name}/`);
        }
        if (existsSync(specPathLegacy)) {
          unlinkSync(specPathLegacy);
          console.log(`[QA] Cleared stale feature-spec.v3.json from .claude/${entry.name}/`);
        }
        if (existsSync(smokePath)) {
          unlinkSync(smokePath);
        }
        if (featureMapLegacyPath && existsSync(featureMapLegacyPath)) {
          unlinkSync(featureMapLegacyPath);
          console.log("[QA] Cleared stale feature-map.json from .claude/feature-map/");
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
  claudeStorageId?: string,
  claudeStorageRootOverride?: string
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
      claudeStorageRootOverride,
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
      claudeStorageRootOverride,
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

async function resetQASession(pipelineId: string): Promise<void> {
  await cleanupSession(pipelineId);
  clearSessionId(pipelineId);
}

function shouldAutoDecompose(featureMap: FeatureMap | null): boolean {
  if (!featureMap) return false;
  if (featureMap.decompositionMode === "selected") {
    return featureMap.selectedFeatureIds.length > 0;
  }
  return featureMap.features.length > 0;
}

function selectCurrentFeature(
  pipeline: Pipeline,
  pendingFeatures: FeatureMapFeature[]
): FeatureMapFeature | null {
  if (pendingFeatures.length === 0) return null;
  const preferredId = pipeline.qa?.featureId;
  const preferredPrefix = pipeline.qa?.featurePrefix;
  const match =
    pendingFeatures.find((feature) => feature.id === preferredId) ||
    pendingFeatures.find((feature) => feature.prefix === preferredPrefix);
  return match ?? pendingFeatures[0];
}

function buildFeatureKickoffPrompt(
  featureMap: FeatureMap,
  feature: FeatureMapFeature,
  userMessage?: string
): string {
  const featureMapPath = getFeatureMapPath(QA_OUTPUT_ROOT);
  const lines = [
    "You are continuing a multi-feature decomposition using the feature map below.",
    `Feature map: \`${featureMapPath}\``,
    "",
    `Project: ${featureMap.projectName}`,
    `Project summary: ${featureMap.projectSummary || "n/a"}`,
    `Target platforms: ${
      featureMap.targetPlatforms.length > 0
        ? featureMap.targetPlatforms.join(", ")
        : "unspecified"
    }`,
    "",
    `Focus ONLY on this feature: ${feature.name} (${feature.id})`,
    `Feature prefix: ${feature.prefix}`,
    `Feature summary: ${feature.summary || "n/a"}`,
    `Dependencies: ${
      feature.dependencies.length > 0 ? feature.dependencies.join(", ") : "none"
    }`,
    "",
    "Output requirements ONLY for this feature.",
    `Write outputs to \`.claude/${feature.prefix}/feature-spec.v3.json\` and \`.claude/${feature.prefix}/smoke-tests.json\`.`,
  ];

  if (userMessage && userMessage.trim().length > 0) {
    lines.push("", `User note: ${userMessage.trim()}`);
  }

  return lines.join("\n");
}

async function runQALoop(
  pipelineId: string,
  message: string,
  targetProjectPath: string | undefined,
  isNewProject: boolean
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  let nextMessage = message;
  let remainingAuto = MAX_AUTO_FEATURES;

  while (true) {
    const featureMap = await loadFeatureMap(QA_OUTPUT_ROOT);
    const pendingFeatures = featureMap
      ? getPendingFeatures(featureMap, QA_OUTPUT_ROOT)
      : [];

    const stage = !featureMap
      ? "map"
      : pendingFeatures.length === 0
        ? "complete"
        : "feature";

    if (stage === "complete") {
      updateQAState(pipelineId, { stage: undefined, featureId: undefined, featurePrefix: undefined });
      await resetQASession(pipelineId);
      await onQAComplete(pipelineId, featureMap ?? undefined);
      return;
    }

    let currentFeature: FeatureMapFeature | null = null;
    if (stage === "feature") {
      currentFeature = selectCurrentFeature(pipeline, pendingFeatures);
      if (!currentFeature) {
        appendEvent(pipelineId, "pipeline_failed", {
          phase: "qa",
          error: "No pending features available for decomposition",
        });
        updateStatus(pipelineId, "failed");
        return;
      }
    }

    const hasSession = activeSessions.has(pipelineId);
    const needsNewSession =
      !hasSession ||
      pipeline.qa?.stage !== stage ||
      (stage === "feature" && pipeline.qa?.featurePrefix !== currentFeature?.prefix);

    if (needsNewSession) {
      await resetQASession(pipelineId);
      updateQAState(pipelineId, {
        stage,
        featureId: currentFeature?.id,
        featurePrefix: currentFeature?.prefix,
      });
    }

    const session = await getOrCreateSession(
      pipelineId,
      targetProjectPath,
      isNewProject,
      pipeline.claudeStorageId,
      QA_STORAGE_ROOT
    );

    if (needsNewSession) {
      appendEvent(pipelineId, "agent_prompt", {
        prompt: session.systemPrompt,
        agentName: "feature-qa",
        phase: "qa",
      });
    }

    const outgoingMessage =
      stage === "feature" && needsNewSession && featureMap && currentFeature
        ? buildFeatureKickoffPrompt(featureMap, currentFeature, nextMessage)
        : nextMessage;

    logPhase("qa", "Sending QA message", outgoingMessage.slice(0, 120));
    let result;
    try {
      result = await session.send(outgoingMessage);
    } catch (error) {
      console.error(`${LOG.qa} Session send error:`, error);
      throw error;
    }

    console.log(`${LOG.qa} Session result:`, {
      requiresUserInput: result.requiresUserInput,
      hasUserQuestions: !!result.userQuestions?.length,
      toolCalls: result.toolCalls?.map(t => t.name),
      replyPreview: result.reply?.slice(0, 500),
    });

    processSessionResult(pipelineId, result);
    addToConversation(pipelineId, "assistant", result.reply);

    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      requiresUserInput: result.requiresUserInput,
      userQuestions: result.userQuestions,
    });

    if (result.requiresUserInput) {
      return;
    }

    const updatedFeatureMap = await loadFeatureMap(QA_OUTPUT_ROOT);
    if (!updatedFeatureMap) {
      if (isQAComplete(result, QA_OUTPUT_ROOT)) {
        await resetQASession(pipelineId);
        await onQAComplete(pipelineId, undefined);
      }
      return;
    }

    const pendingAfter = getPendingFeatures(updatedFeatureMap, QA_OUTPUT_ROOT);
    if (pendingAfter.length === 0) {
      updateQAState(pipelineId, { stage: undefined, featureId: undefined, featurePrefix: undefined });
      await resetQASession(pipelineId);
      await onQAComplete(pipelineId, updatedFeatureMap);
      return;
    }

    const featureCompleted =
      stage === "feature" &&
      currentFeature &&
      existsSync(getFeatureSpecPath(currentFeature.prefix, QA_OUTPUT_ROOT));
    const mapCompleted = stage === "map" && updatedFeatureMap;
    if (featureCompleted || mapCompleted) {
      await resetQASession(pipelineId);
    }

    if (!shouldAutoDecompose(updatedFeatureMap)) {
      appendEvent(pipelineId, "status_update", {
        action: "Feature map ready. Send a message to select features for decomposition.",
        phase: "qa",
        statusSource: "orchestrator",
      });
      return;
    }

    if (remainingAuto <= 0) {
      appendEvent(pipelineId, "status_update", {
        action: "Feature decomposition paused; send a message to continue.",
        phase: "qa",
        statusSource: "orchestrator",
      });
      return;
    }

    remainingAuto -= 1;
    nextMessage = "";
  }
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

  // Generate a temporary claudeStorageId early so QA artifacts (feature-map.json,
  // feature-understanding.json) are written to a project-specific folder
  let claudeStorageId = pipeline.claudeStorageId;
  if (!claudeStorageId) {
    claudeStorageId = generateClaudeStorageId("qa", pipelineId);
    setClaudeStorageId(pipelineId, claudeStorageId);
    console.log(`${LOG.qa} Set temporary claudeStorageId: ${claudeStorageId}`);
  }

  markRunning(pipelineId);

  console.log(`${LOG.qa} Starting QA phase for pipeline ${pipelineId.slice(0, 8)}`);
  if (isNewProject) {
    await clearFeatureSpecs(QA_OUTPUT_ROOT, claudeStorageId);
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

    // Store conversation history (for backwards compatibility with existing code)
    addToConversation(pipelineId, "user", initialPrompt);

    await runQALoop(pipelineId, initialPrompt, resolvedTargetPath, isNewProject);
  } catch (error) {
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
  } finally {
    markStopped(pipelineId);
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

    await runQALoop(
      pipelineId,
      message,
      pipeline.targetProjectPath,
      pipeline.isNewProject ?? false
    );
  } catch (error) {
    await cleanupSession(pipelineId);
    appendEvent(pipelineId, "pipeline_failed", {
      phase: "qa",
      error: error instanceof Error ? error.message : "Unknown error",
    });
    updateStatus(pipelineId, "failed");
  } finally {
    markStopped(pipelineId);
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
 * Get path to feature understanding file
 */
function getFeatureUnderstandingPath(rootPath?: string): string {
  const root = rootPath ? resolve(rootPath) : FLIGHTPATH_ROOT;
  return join(root, ".claude", "feature-understanding.json");
}

/**
 * Check if QA phase is complete
 * QA is complete when feature-understanding.json has been written.
 */
function isQAComplete(result: V2SessionTurnResult, rootPath?: string): boolean {
  // Primary: Check if agent wrote to the understanding file via tool calls
  const wroteUnderstandingFile = result.toolCalls?.some(
    (call) =>
      call.name === "Write" &&
      String((call.args as Record<string, unknown>)?.file_path || "").includes("feature-understanding.json")
  );

  if (wroteUnderstandingFile) {
    console.log(`${LOG.qa} Checking completion... result=true (understanding file written by agent)`);
    return true;
  }

  // Fallback: Check actual file existence
  const understandingPath = getFeatureUnderstandingPath(rootPath);
  if (existsSync(understandingPath)) {
    console.log(`${LOG.qa} Checking completion... result=true (understanding file exists at ${understandingPath})`);
    return true;
  }

  console.log(`${LOG.qa} Checking completion... result=false (no understanding file)`);
  return false;
}

/**
 * Run the feature-spec agent to generate structured spec from understanding
 */
async function runSpecGeneration(
  pipelineId: string,
  targetProjectPath: string,
  featurePrefix?: string
): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  const understandingPath = getFeatureUnderstandingPath(QA_OUTPUT_ROOT);
  if (!existsSync(understandingPath)) {
    throw new Error("Feature understanding file not found");
  }

  appendEvent(pipelineId, "status_update", {
    action: "Generating feature specification from understanding...",
    phase: "qa",
    statusSource: "orchestrator",
  });

  const toolCallbacks = createToolCallbacks(pipelineId, "qa", "feature-spec");

  // Create a non-interactive session for the spec agent
  const session = await createV2Session({
    agentName: "feature-spec",
    pipelineId,
    targetProjectPath,
    claudeStorageId: pipeline.claudeStorageId,
    claudeStorageRootOverride: QA_STORAGE_ROOT,
    isNewProject: false,
    toolCallbacks,
    maxTurns: 100,
  });

  try {
    appendEvent(pipelineId, "agent_prompt", {
      prompt: session.systemPrompt,
      agentName: "feature-spec",
      phase: "qa",
    });

    // Send the understanding file path to the spec agent
    const prompt = featurePrefix
      ? `Generate the feature specification for feature "${featurePrefix}" from the understanding document at: ${understandingPath}`
      : `Generate the feature specification from the understanding document at: ${understandingPath}`;

    logPhase("qa", "Running feature-spec agent", prompt.slice(0, 100));
    const result = await session.send(prompt);

    processSessionResult(pipelineId, result);
    addToConversation(pipelineId, "assistant", result.reply);

    appendEvent(pipelineId, "agent_message", {
      content: result.reply,
      streaming: false,
      agentName: "feature-spec",
    });

    // Verify spec was generated
    const specWritten = result.toolCalls?.some(
      (call) =>
        call.name === "Write" &&
        String((call.args as Record<string, unknown>)?.file_path || "").includes("feature-spec.json")
    );

    if (!specWritten) {
      console.warn(`${LOG.qa} feature-spec agent did not write a spec file`);
    }
  } finally {
    await session.close();
  }
}

/**
 * Handle QA completion - run spec generation, then parse requirements and start the loop
 */
async function onQAComplete(
  pipelineId: string,
  featureMap?: FeatureMap
): Promise<void> {
  const pipeline = getPipeline(pipelineId);

  const primaryFeature = featureMap ? selectPrimaryFeature(featureMap) : null;
  if (primaryFeature) {
    appendEvent(pipelineId, "status_update", {
      action: `Selected feature "${primaryFeature.name}" (${primaryFeature.prefix}) for spec generation`,
      phase: "qa",
      statusSource: "orchestrator",
    });
  }

  // Run feature-spec agent to generate structured requirements from understanding
  const specTargetPath = pipeline?.targetProjectPath || QA_OUTPUT_ROOT;
  await runSpecGeneration(pipelineId, specTargetPath, primaryFeature?.prefix);

  appendEvent(pipelineId, "qa_completed", {});
  appendEvent(pipelineId, "requirements_ready", {
    message: "Requirements have been generated",
  });

  // Parse requirements, epics, project name, and feature prefix from the feature spec
  let specRoot = QA_OUTPUT_ROOT;
  let parsed = await parseRequirementsFromSpec(specRoot, primaryFeature?.prefix);

  if (parsed.requirements.length === 0 && pipeline?.targetProjectPath) {
    specRoot = pipeline.targetProjectPath;
    parsed = await parseRequirementsFromSpec(specRoot, primaryFeature?.prefix);
  }

  const { requirements, epics, projectName, featurePrefix } = parsed;

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

  let targetPath = pipeline?.targetProjectPath || generateTargetProjectPath(projectName);
  const desiredPath = generateTargetProjectPath(projectName);

  if (pipeline?.isNewProject && pipeline.targetProjectPath && pipeline.targetProjectPath !== desiredPath) {
    try {
      const { rename, mkdir } = await import("node:fs/promises");
      if (!existsSync(desiredPath)) {
        await mkdir(dirname(desiredPath), { recursive: true });
        await rename(pipeline.targetProjectPath, desiredPath);
        targetPath = desiredPath;
        console.log(`[QA] Moved project directory: ${pipeline.targetProjectPath} -> ${desiredPath}`);
      } else {
        console.warn(`[QA] Target project path already exists: ${desiredPath}. Keeping ${pipeline.targetProjectPath}.`);
      }
    } catch (error) {
      console.warn(
        `[QA] Failed to move project directory from ${pipeline.targetProjectPath} to ${desiredPath}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  } else if (!pipeline?.targetProjectPath) {
    targetPath = desiredPath;
  }

  setTargetProjectPath(pipelineId, targetPath);

  const cleanupSource = pipeline?.isNewProject ?? false;
  const isStagingSpecRoot = specRoot === QA_OUTPUT_ROOT;
  const shouldCleanupSource =
    isStagingSpecRoot || (cleanupSource && specRoot !== QA_OUTPUT_ROOT);

  // Create target directory and copy feature spec to backend/.claude storage
  await initializeTargetProject(
    targetPath,
    claudeStorageId,
    featurePrefix,
    specRoot,
    shouldCleanupSource
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
