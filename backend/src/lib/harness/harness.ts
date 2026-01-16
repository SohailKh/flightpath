/**
 * Harness
 *
 * Thin wrapper that runs the agent with full autonomy.
 * The agent decides phases, retries, and workflow - harness just provides
 * the environment and handles cleanup.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKResultMessage, type SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  getPipeline,
  updateStatus,
  updatePhase,
  updateRequirement,
  appendEvent,
  addArtifact,
  addCompletedRequirement,
  addFailedRequirement,
  setCurrentRunId,
  markRunning,
  markStopped,
  isAbortRequested,
  setFeaturePrefix,
  setUserInputRequest,
  type PipelinePhase,
  type UserInputEntry,
  type Requirement,
} from "../pipeline";
import { EventBridge } from "./event-bridge";
import { areAllRequirementsProcessed, getRequirementsSummary } from "./requirements";
import { createWorkflowMcpServer } from "./workflow-mcp";
import { writeRequirementsSnapshot } from "./requirements-store";
import {
  initBrowser,
  closeBrowser,
  executePlaywrightTool,
} from "../playwright-tools";
import { saveScreenshot } from "../artifacts";
import { rewriteClaudeCommand, rewriteClaudeFilePath } from "../claude-paths";
import { parseRequirementsFromSpec } from "../orchestrator/project-init";
import { notifyTelegramQuestions } from "../telegram";
import { categorizeErrorWithDetails } from "../parallel-explorer";
import { buildClaudeCodeOptions, createPromptStream } from "../claude-query";
import { ensureLocalClaudeForToolInput, ensureProjectClaudeLayout } from "../claude-scaffold";

/**
 * Harness configuration
 */
export interface HarnessConfig {
  pipelineId: string;
  requirements: Requirement[];
  targetProjectPath: string;
  model?: string;
  maxTurns?: number; // Safety valve, default 500
  enablePlaywright?: boolean;
  /** Max plan→execute→test attempts per requirement (default: 3) */
  maxAttemptsPerRequirement?: number;
  /** Enable automatic retry on rate limit errors (default: true) */
  retryOnRateLimit?: boolean;
  /** Backoff duration between retries in ms (default: 30 minutes) */
  rateLimitBackoffMs?: number;
  /** Maximum number of retries (default: 20, ~10 hours) */
  maxRetries?: number;
}

/**
 * Harness result
 */
export interface HarnessResult {
  success: boolean;
  completedRequirements: string[];
  failedRequirements: string[];
  totalTurns: number;
  durationMs: number;
  aborted: boolean;
}

const HARNESS_SYSTEM_APPEND = [
  "Harness mode:",
  "- Use mcp__workflow__get_requirements when you need requirement context.",
  "- Use mcp__workflow__update_status for progress notes.",
  "- Only call mcp__workflow__complete_requirement in the testing phase after tests pass.",
  "- Do not call mcp__workflow__fail_requirement unless explicitly instructed.",
  "- Use mcp__workflow__log_progress for notable milestones.",
].join("\n");

const PLAYWRIGHT_TOOL_SUMMARY =
  "Playwright tools available: web_navigate, web_click, web_type, web_fill, web_assert_visible, web_assert_text, web_wait, web_screenshot, web_http_request. See /testing for details.";

function formatRequirementContext(requirement: Requirement): string {
  const criteria =
    requirement.acceptanceCriteria.length > 0
      ? requirement.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
      : "- (none)";
  return [
    `ID: ${requirement.id}`,
    `Title: ${requirement.title}`,
    `Priority: ${requirement.priority}`,
    "Description:",
    requirement.description || "(none)",
    "Acceptance Criteria:",
    criteria,
  ].join("\n");
}

function extractJsonBlock(text: string): unknown | null {
  if (!text) return null;
  const matches = Array.from(text.matchAll(/```json\s*([\s\S]*?)\s*```/g));
  if (matches.length === 0) return null;
  const jsonText = matches[matches.length - 1][1];
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function parseTestStatus(output: string): "passed" | "failed" | null {
  const parsed = extractJsonBlock(output);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const status = record.status;
    if (status === "passed" || status === "failed") {
      return status;
    }
    if (typeof record.passed === "boolean") {
      return record.passed ? "passed" : "failed";
    }
  }

  const marker = output.match(/TEST_RESULT:\s*(PASS|FAIL)/i);
  if (marker) {
    return marker[1].toUpperCase() === "PASS" ? "passed" : "failed";
  }

  return null;
}

function buildBasePrompt(
  targetProjectPath: string,
  enablePlaywright: boolean,
  claudeStorageId: string,
  userInputs: UserInputEntry[]
): string {
  let prompt = "";

  prompt += "## Harness Instructions\n\n";
  prompt += "- Use `mcp__workflow__get_requirements` if you need a list of requirements.\n";
  prompt += "- Do not call `mcp__workflow__start_requirement` or `mcp__workflow__fail_requirement` unless explicitly instructed.\n";
  prompt += "- Do not mark requirements complete during planning or execution.\n";
  prompt += "- Use `AskUserQuestion` when blocked and batch related questions.\n\n";

  if (enablePlaywright) {
    prompt += "## Playwright\n\n";
    prompt += `${PLAYWRIGHT_TOOL_SUMMARY}\n\n`;
  }

  prompt += `## Working Directory\n\n\`${targetProjectPath}\`\n\n`;

  if (claudeStorageId) {
    prompt += "## Claude Storage ID\n\n";
    prompt += `\`${claudeStorageId}\`\n`;
    prompt += "Set `CLAUDE_STORAGE_ID` when running Playwright scripts.\n\n";
  }

  if (userInputs.length > 0) {
    prompt += "## User Inputs (Most Recent First)\n\n";
    const recentInputs = [...userInputs].slice(-5).reverse();
    for (const entry of recentInputs) {
      prompt += `- ${entry.ts}\n`;
      if (entry.questions && entry.questions.length > 0) {
        prompt += "  Questions:\n";
        for (const q of entry.questions) {
          const label = q.header || "Question";
          const text = q.question ? `: ${q.question}` : "";
          prompt += `  - ${label}${text}\n`;
        }
      }
      const responseText = entry.message.trim() || "(no response)";
      prompt += "  Response:\n";
      prompt += "  ```\n";
      prompt += `${responseText}\n`;
      prompt += "  ```\n\n";
    }
  }

  return prompt;
}

function buildPlanningPrompt(
  basePrompt: string,
  requirement: Requirement
): string {
  return [
    basePrompt,
    "## Phase: Planning",
    "",
    "Create a concise implementation plan for the requirement below.",
    "Do NOT write code in this phase.",
    "Use repository tools as needed to inspect existing patterns.",
    "",
    "Requirement:",
    formatRequirementContext(requirement),
    "",
    "Return the plan as JSON in a fenced block:",
    "```json",
    "{",
    `  \"requirementId\": \"${requirement.id}\",`,
    "  \"steps\": [",
    "    { \"step\": \"...\", \"files\": [\"...\"] }",
    "  ],",
    "  \"notes\": \"\"",
    "}",
    "```",
    "",
  ].join("\n");
}

function buildExecutionPrompt(
  basePrompt: string,
  requirement: Requirement,
  planText: string
): string {
  return [
    basePrompt,
    "## Phase: Execution",
    "",
    "Implement the requirement using the plan below.",
    "Do NOT mark the requirement complete; testing will do that.",
    "Run any relevant type checks or unit tests for your changes.",
    "",
    "Requirement:",
    formatRequirementContext(requirement),
    "",
    "Plan:",
    "```json",
    planText.trim(),
    "```",
    "",
  ].join("\n");
}

function buildRuntimeSkillPrompt(basePrompt: string): string {
  return [
    basePrompt,
    "## Task: Generate Runtime Instantiator Skill",
    "",
    "Create or update `.claude/skills/runtime-instantiator` in this repo.",
    "Goal: allow the tester to start the app locally, detect BASE_URL, and stop it without asking the user.",
    "",
    "Requirements:",
    "- Create `.claude/skills/runtime-instantiator/SKILL.md` with YAML frontmatter:",
    "  - name: runtime-instantiator",
    "  - description: Start/stop the app under test and emit BASE_URL for Playwright testing.",
    "- Create `scripts/start.sh` and `scripts/stop.sh` (bash, ASCII).",
    "- start.sh must:",
    "  - Be idempotent: if runtime.json exists and PID is alive, echo `BASE_URL=...` and exit 0.",
    "  - Choose a start command by inspecting the repo (package.json scripts, README, Makefile, common framework files).",
    "  - Start the app in the background, log to `.claude/skills/runtime-instantiator/runtime.log`.",
    "  - Wait for readiness (curl baseUrl or health URL) with a timeout.",
    "  - Write `.claude/skills/runtime-instantiator/runtime.json` with baseUrl, pid, command, startedAt, strategy, healthUrl (if any).",
    "  - Echo `BASE_URL=...` on success; exit non-zero on failure.",
    "- stop.sh must:",
    "  - Read runtime.json and terminate the PID (SIGTERM then SIGKILL), cleanup runtime.json.",
    "",
    "Heuristics:",
    "- If package.json exists, prefer the package manager's dev/start script.",
    "- Infer port from scripts or framework defaults (Next: 3000, Vite: 5173).",
    "- If no runtime is obvious and index.html exists, use `python3 -m http.server` on port 8000.",
    "- Prefer deterministic defaults over asking the user. Do NOT ask the user.",
    "",
    "Do not modify application code; only create/update the skill files.",
    "",
  ].join("\n");
}

function buildTestingPrompt(
  basePrompt: string,
  requirement: Requirement,
  featurePrefix: string,
  claudeStorageId: string,
  runId: string,
  runtimeSkillPath: string
): string {
  return [
    basePrompt,
    "## Phase: Testing",
    "",
    "Run Playwright smoke tests and capture at least one screenshot.",
    "Use the runtime instantiator skill to start the app and detect BASE_URL.",
    `Skill: \`${runtimeSkillPath}\``,
    "",
    "If the skill is missing or stale, create/update it before testing.",
    "Do NOT ask the user for BASE_URL unless startup fails after reasonable attempts.",
    "",
    "Suggested flow:",
    "```bash",
    "BASE_URL=$(bash .claude/skills/runtime-instantiator/scripts/start.sh | sed -n 's/^BASE_URL=//p' | tail -1)",
    "export BASE_URL",
    "```",
    "",
    "After startup, read `.claude/skills/runtime-instantiator/runtime.json` and call",
    "`mcp__workflow__update_status` with the baseUrl + strategy for telemetry.",
    "",
    "Use the scripts below (do not use web_* tools for testing):",
    "",
    `- FEATURE_PREFIX: ${featurePrefix}`,
    `- CLAUDE_STORAGE_ID: ${claudeStorageId}`,
    `- RUN_ID: ${runId}`,
    "",
    "Commands:",
    "```bash",
    `bun run playwright:smoke -- --baseUrl \"$BASE_URL\" --featurePrefix \"${featurePrefix}\" --runId \"${runId}\" --claudeStorageId \"${claudeStorageId}\"`,
    `bun run playwright:screenshot -- --baseUrl \"$BASE_URL\" --featurePrefix \"${featurePrefix}\" --runId \"${runId}\" --claudeStorageId \"${claudeStorageId}\" --name \"${requirement.id}\"`,
    "```",
    "",
    "After tests, stop the runtime:",
    "```bash",
    "bash .claude/skills/runtime-instantiator/scripts/stop.sh",
    "```",
    "",
    "Requirement:",
    formatRequirementContext(requirement),
    "",
    "After testing:",
    "- If tests pass: call `mcp__workflow__complete_requirement`.",
    "- If tests fail: call `mcp__workflow__update_status` with status `in_progress` and a failure note.",
    "",
    "Return a JSON status block and a TEST_RESULT marker:",
    "```json",
    "{",
    `  \"requirementId\": \"${requirement.id}\",`,
    "  \"status\": \"passed\"",
    "}",
    "```",
    "TEST_RESULT: PASS",
    "",
  ].join("\n");
}

/**
 * Run the harness with the agent
 */
export async function runHarness(config: HarnessConfig): Promise<HarnessResult> {
  const {
    pipelineId,
    requirements,
    targetProjectPath,
    model = "opus",
    maxTurns = 500,
    enablePlaywright = true,
    maxAttemptsPerRequirement = 3,
    retryOnRateLimit = true,
    rateLimitBackoffMs = 30 * 60 * 1000, // 30 minutes
    maxRetries = 20, // ~10 hours of retrying
  } = config;

  const pipeline = getPipeline(pipelineId);
  if (!pipeline) {
    throw new Error(`Pipeline not found: ${pipelineId}`);
  }

  let featurePrefix = pipeline.featurePrefix;
  if (!featurePrefix) {
    try {
      const parsed = await parseRequirementsFromSpec(
        pipeline.isNewProject ? targetProjectPath : undefined
      );
      featurePrefix = parsed.featurePrefix || "pipeline";
      setFeaturePrefix(pipelineId, featurePrefix);
    } catch (error) {
      console.warn(`[Harness] Failed to resolve feature prefix: ${error instanceof Error ? error.message : String(error)}`);
      featurePrefix = "pipeline";
    }
  }
  const resolvedFeaturePrefix = featurePrefix || "pipeline";

  await ensureProjectClaudeLayout(targetProjectPath);

  console.log(`[Harness] Starting with ${requirements.length} requirements`);
  console.log(`[Harness] Model: ${model}, MaxTurns: ${maxTurns}, Playwright: ${enablePlaywright}`);
  console.log(`[Harness] Rate limit retry: ${retryOnRateLimit ? `enabled (${maxRetries} retries, ${rateLimitBackoffMs / 60000}min backoff)` : "disabled"}`);

  // Mark pipeline as running
  markRunning(pipelineId);
  updateStatus(pipelineId, "running" as any); // Status will be added to pipeline.ts

  const startTime = Date.now();
  let totalTurns = 0;
  let aborted = false;
  let pausedForUserInput = false;

  // Initialize event bridge
  const eventBridge = new EventBridge(pipelineId);
  const claudeStorageId = pipeline.claudeStorageId;

  const rewriteToolInput = (
    toolName: string,
    toolInput: unknown
  ): { resolvedInput: unknown; updatedInput?: Record<string, unknown> } => {
    if (!claudeStorageId || !toolInput || typeof toolInput !== "object") {
      return { resolvedInput: toolInput };
    }

    const input = toolInput as Record<string, unknown>;
    const next: Record<string, unknown> = { ...input };
    let updated = false;

    const updatePathKey = (key: string) => {
      const raw = input[key];
      if (typeof raw !== "string") return;
      const rewritten = rewriteClaudeFilePath(raw, claudeStorageId);
      if (rewritten !== raw) {
        next[key] = rewritten;
        updated = true;
      }
    };

    switch (toolName) {
      case "Read":
      case "Edit":
      case "Write":
        updatePathKey("file_path");
        break;
      case "Glob":
        updatePathKey("pattern");
        break;
      case "Grep":
        updatePathKey("path");
        break;
      case "LS":
      case "Tree":
        updatePathKey("path");
        updatePathKey("directory");
        break;
      case "Bash": {
        const rawCommand = input.command;
        if (typeof rawCommand === "string") {
          const rewritten = rewriteClaudeCommand(rawCommand, claudeStorageId);
          if (rewritten !== rawCommand) {
            next.command = rewritten;
            updated = true;
          }
        }
        break;
      }
      default:
        updatePathKey("path");
        updatePathKey("directory");
        break;
    }

    if (!updated) {
      return { resolvedInput: toolInput };
    }

    return { resolvedInput: next, updatedInput: next };
  };

  const recordScreenshot = async (
    screenshot: Buffer,
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<void> => {
    try {
      // Use claudeStorageId for centralized artifact storage in backend/.claude/
      const saved = await saveScreenshot(
        screenshot,
        undefined,
        pipeline.claudeStorageId,
        resolvedFeaturePrefix
      );
      addArtifact(pipelineId, {
        id: saved.id,
        type: saved.type,
        path: saved.path,
      });
      appendEvent(pipelineId, "screenshot_captured", {
        artifactId: saved.id,
        path: saved.path,
        tool: toolName,
        name: toolInput?.name,
      });
    } catch (error) {
      console.warn(
        `[Harness] Failed to save screenshot: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };

  // Initialize Playwright if enabled
  if (enablePlaywright) {
    await initBrowser();
  }

  // Helper to sleep with abort checking
  const sleepWithAbortCheck = async (ms: number, checkIntervalMs = 5000): Promise<boolean> => {
    const endTime = Date.now() + ms;
    while (Date.now() < endTime) {
      if (isAbortRequested(pipelineId)) {
        return true; // Aborted
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(checkIntervalMs, endTime - Date.now())));
    }
    return false; // Not aborted
  };

  let retryCount = 0;

  try {
    const workflowServer = createWorkflowMcpServer(pipelineId, eventBridge);
    await writeRequirementsSnapshot(pipelineId);
    const basePrompt = buildBasePrompt(
      targetProjectPath,
      enablePlaywright,
      pipeline.claudeStorageId || "default",
      pipeline.userInputLog ?? []
    );
    const runtimeSkillRelativePath = ".claude/skills/runtime-instantiator/SKILL.md";
    const runtimeSkillPath = join(targetProjectPath, runtimeSkillRelativePath);
    let runtimeSkillAttempted = false;

    const ensureRuntimeSkill = async (): Promise<void> => {
      if (!enablePlaywright || runtimeSkillAttempted) return;
      runtimeSkillAttempted = true;

      if (existsSync(runtimeSkillPath)) return;

      appendEvent(pipelineId, "status_update", {
        action: "Generating runtime-instantiator skill for testing.",
        phase: "testing",
        statusSource: "system",
      });

      const skillPrompt = buildRuntimeSkillPrompt(basePrompt);
      await runAgentPhase("testing", skillPrompt, "runtime-instantiator");

      if (existsSync(runtimeSkillPath)) {
        appendEvent(pipelineId, "status_update", {
          action: "Runtime-instantiator skill ready.",
          phase: "testing",
          statusSource: "system",
        });
      } else {
        appendEvent(pipelineId, "status_update", {
          action: "Runtime-instantiator skill missing after generation attempt.",
          phase: "testing",
          statusSource: "system",
        });
      }
    };

    const orderedRequirements = requirements
      .map((req, index) => ({ req, index }))
      .sort((a, b) =>
        a.req.priority === b.req.priority
          ? a.index - b.index
          : a.req.priority - b.req.priority
      )
      .map(({ req }) => req);

    const runAgentPhase = async (
      phase: PipelinePhase,
      prompt: string,
      phaseLabel: string
    ): Promise<{ lastAssistantText: string }> => {
      let phaseTurns = 0;
      let lastAssistantText = "";
      let previousInputTokens = 0;
      let previousOutputTokens = 0;

      appendEvent(pipelineId, "agent_prompt", {
        prompt,
        agentName: `harness-${phaseLabel}`,
        phase,
      });
      appendEvent(pipelineId, "status_update", {
        action: `Starting ${phaseLabel} agent...`,
        phase,
        statusSource: "system",
      });

      // Retry loop for rate limit recovery
      while (true) {
        let promptStream: ReturnType<typeof createPromptStream> | null = null;
        try {
          // Run the agent
          promptStream = createPromptStream(prompt);
          const q = query({
            prompt: promptStream.prompt,
            options: buildClaudeCodeOptions({
              maxTurns,
              model,
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              cwd: targetProjectPath,
              mcpServers: { workflow: workflowServer },
              systemPromptAppend: HARNESS_SYSTEM_APPEND,
              hooks: {
                PreToolUse: [
                  {
                    hooks: [
                      async (input) => {
                        if (input.hook_event_name !== "PreToolUse") {
                          return { continue: true };
                        }

                        // Check for abort
                        if (isAbortRequested(pipelineId)) {
                          aborted = true;
                          return {
                            continue: false,
                            tool_result: "Pipeline aborted by user",
                          };
                        }

                        const toolName = input.tool_name;
                        const { resolvedInput, updatedInput } = rewriteToolInput(
                          toolName,
                          input.tool_input
                        );

                        await ensureLocalClaudeForToolInput(
                          toolName,
                          resolvedInput,
                          targetProjectPath
                        );

                        // Handle TodoWrite for real-time updates
                        if (toolName === "TodoWrite") {
                          const todoInput = resolvedInput as { todos?: unknown[] };
                          if (todoInput?.todos) {
                            eventBridge.onTodoWrite(todoInput.todos);
                          }
                        }

                        if (toolName === "AskUserQuestion") {
                          const questions = (resolvedInput as { questions?: UserInputEntry["questions"] })
                            ?.questions;
                          setUserInputRequest(pipelineId, questions);
                          appendEvent(pipelineId, "paused", {
                            reason: "user_input",
                            questions: questions ?? [],
                          });
                          updateStatus(pipelineId, "paused");
                          pausedForUserInput = true;
                          void notifyTelegramQuestions(
                            pipelineId,
                            questions ?? [],
                            pipeline.phase.current
                          );
                          eventBridge.onToolStart(toolName, resolvedInput, input.tool_use_id);
                          return {
                            continue: false,
                            tool_result:
                              "Questions have been sent to the user. Please wait for their response before continuing.",
                          };
                        }

                        // Handle Playwright tools
                        if (enablePlaywright && toolName.startsWith("web_")) {
                          try {
                            const result = await executePlaywrightTool(
                              toolName,
                              resolvedInput as Record<string, unknown>
                            );

                            if (result.screenshot && Buffer.isBuffer(result.screenshot)) {
                              await recordScreenshot(
                                result.screenshot,
                                toolName,
                                resolvedInput as Record<string, unknown>
                              );
                            }

                            // Emit tool events
                            eventBridge.onToolStart(toolName, resolvedInput, input.tool_use_id);
                            eventBridge.onToolComplete(
                              toolName,
                              resolvedInput,
                              input.tool_use_id,
                              result
                            );

                            // Serialize result (without screenshot buffer)
                            const serializedResult = {
                              ...result,
                              screenshot: result.screenshot ? "(screenshot captured)" : undefined,
                            };

                            return {
                              continue: true,
                              tool_result: JSON.stringify(serializedResult),
                            };
                          } catch (error) {
                            const errorMsg = error instanceof Error ? error.message : String(error);
                            eventBridge.onToolError(
                              toolName,
                              resolvedInput,
                              input.tool_use_id,
                              errorMsg
                            );
                            return {
                              continue: true,
                              tool_result: JSON.stringify({
                                success: false,
                                action: toolName,
                                error: errorMsg,
                              }),
                            };
                          }
                        }

                        // Standard tools - emit events
                        eventBridge.onToolStart(toolName, resolvedInput, input.tool_use_id);

                        if (updatedInput) {
                          return {
                            continue: true,
                            hookSpecificOutput: {
                              hookEventName: "PreToolUse",
                              updatedInput,
                            },
                          };
                        }

                        return { continue: true };
                      },
                    ],
                  },
                ],
                PostToolUse: [
                  {
                    hooks: [
                      async (input) => {
                        if (input.hook_event_name === "PostToolUse") {
                          // Don't double-emit for playwright tools (handled above)
                          if (!input.tool_name.startsWith("web_")) {
                            eventBridge.onToolComplete(
                              input.tool_name,
                              input.tool_input,
                              input.tool_use_id,
                              input.tool_response
                            );
                          }
                        }
                        return { continue: true };
                      },
                    ],
                  },
                ],
                PostToolUseFailure: [
                  {
                    hooks: [
                      async (input) => {
                        if (input.hook_event_name === "PostToolUseFailure") {
                          eventBridge.onToolError(
                            input.tool_name,
                            input.tool_input,
                            input.tool_use_id,
                            input.error
                          );
                        }
                        return { continue: true };
                      },
                    ],
                  },
                ],
              },
            }),
          });

          // Process agent messages
          for await (const msg of q) {
            if (msg.type === "assistant") {
              totalTurns++;
              phaseTurns++;
              console.log(`[Harness] ${phaseLabel} turn ${phaseTurns}/${maxTurns}`);

              const assistantMsg = msg as SDKAssistantMessage;

              // Debug: Log message structure
              console.log(`[Harness] Message has usage: ${!!assistantMsg.message?.usage}`);
              if (assistantMsg.message?.usage) {
                console.log(`[Harness] Usage data: ${JSON.stringify(assistantMsg.message.usage)}`);
              }

              // Emit events for all content blocks
              const messageContent = assistantMsg.message?.content;
              if (messageContent && Array.isArray(messageContent)) {
                const textParts: string[] = [];

                for (const block of messageContent) {
                  if (block.type === "text") {
                    textParts.push(block.text);
                  } else if (block.type === "thinking") {
                    // Extended thinking block
                    appendEvent(pipelineId, "assistant_thinking", {
                      content: (block as { type: "thinking"; thinking: string }).thinking,
                      turnNumber: totalTurns,
                    });
                  } else if (block.type === "tool_use") {
                    // Tool use block (before execution)
                    const toolBlock = block as { type: "tool_use"; id: string; name: string; input: unknown };
                    appendEvent(pipelineId, "assistant_tool_use", {
                      toolName: toolBlock.name,
                      toolUseId: toolBlock.id,
                      input: toolBlock.input,
                      turnNumber: totalTurns,
                    });
                  } else {
                    // Generic content block for any other types
                    appendEvent(pipelineId, "assistant_content_block", {
                      blockType: block.type,
                      block,
                      turnNumber: totalTurns,
                    });
                  }
                }

                // Emit combined text content
                const textContent = textParts.join("\n");
                if (textContent) {
                  lastAssistantText = textContent;
                  appendEvent(pipelineId, "agent_response", {
                    content: textContent,
                    turnNumber: totalTurns,
                  });
                }
              }

              // Extract token usage and pass delta to EventBridge for next tool_completed
              const usage = assistantMsg.message?.usage;
              if (usage) {
                const deltaInput = (usage.input_tokens ?? 0) - previousInputTokens;
                const deltaOutput = (usage.output_tokens ?? 0) - previousOutputTokens;
                previousInputTokens = usage.input_tokens ?? 0;
                previousOutputTokens = usage.output_tokens ?? 0;

                eventBridge.setTurnTokenDelta(deltaInput, deltaOutput);
                console.log(`[Harness] Token delta: +${deltaInput} in, +${deltaOutput} out`);
              } else {
                console.log(`[Harness] No usage data in assistant message`);
              }
            }

            if (msg.type === "result") {
              promptStream?.close();
              const result = msg as SDKResultMessage;
              if (result.subtype === "success") {
                console.log(`[Harness] Agent completed successfully`);

                // Debug: Log result structure
                console.log(`[Harness] Result has usage: ${"usage" in result}`);
                if ("usage" in result) {
                  console.log(`[Harness] Final usage: ${JSON.stringify(result.usage)}`);
                }

                // Emit token_usage event if available
                // SDKResultMessage.usage has input_tokens and output_tokens
                if ("usage" in result && result.usage) {
                  appendEvent(pipelineId, "token_usage", {
                    inputTokens: result.usage.input_tokens ?? 0,
                    outputTokens: result.usage.output_tokens ?? 0,
                    totalTurns,
                    ...(result.total_cost_usd !== undefined && { totalCostUsd: result.total_cost_usd }),
                  });
                  console.log(`[Harness] Emitted token_usage event: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out`);
                }
              } else if (result.subtype === "error_max_turns") {
                console.log(`[Harness] Agent hit max turns limit (${maxTurns})`);
                appendEvent(pipelineId, "agent_error_detail", {
                  error: `Agent hit max turns limit (${maxTurns})`,
                  subtype: result.subtype,
                  totalTurns,
                });
              } else {
                console.error(`[Harness] Agent error: ${result.subtype}`);
                appendEvent(pipelineId, "agent_error_detail", {
                  error: `Agent error: ${result.subtype}`,
                  subtype: result.subtype,
                  totalTurns,
                });
                if ("errors" in result && Array.isArray(result.errors)) {
                  for (const err of result.errors) {
                    console.error(`[Harness] Error detail: ${err}`);
                    appendEvent(pipelineId, "agent_error_detail", {
                      error: err,
                      subtype: result.subtype,
                      totalTurns,
                    });
                  }
                }
              }
            }
          }

          // Agent completed (success or handled error), exit retry loop
          break;
        } catch (error) {
          // Check if this is a retryable error (rate limit, transient)
          const errorMsg = error instanceof Error ? error.message : String(error);
          const errorInfo = categorizeErrorWithDetails(errorMsg);

          if (retryOnRateLimit && errorInfo.retryable && retryCount < maxRetries) {
            retryCount++;
            const backoffMinutes = Math.round(rateLimitBackoffMs / 60000);
            const resumeAt = new Date(Date.now() + rateLimitBackoffMs).toISOString();

            console.log(`[Harness] Rate limit hit, retry ${retryCount}/${maxRetries} in ${backoffMinutes}min`);
            console.log(`[Harness] Error: ${errorMsg}`);
            console.log(`[Harness] Will resume at: ${resumeAt}`);

            appendEvent(pipelineId, "rate_limit_retry", {
              retryCount,
              maxRetries,
              backoffMs: rateLimitBackoffMs,
              resumeAt,
              error: errorMsg,
              errorType: errorInfo.type,
            });

            // Wait with abort checking
            const wasAborted = await sleepWithAbortCheck(rateLimitBackoffMs);
            if (wasAborted) {
              aborted = true;
              console.log(`[Harness] Aborted during rate limit backoff`);
              break;
            }

            console.log(`[Harness] Resuming after rate limit backoff (attempt ${retryCount})`);
            appendEvent(pipelineId, "status_update", {
              action: `Resuming after rate limit (attempt ${retryCount}/${maxRetries})...`,
              statusSource: "system",
            });

            // Continue the while loop to retry
            continue;
          }

          // Non-retryable error or max retries exceeded
          console.error(`[Harness] Non-retryable error or max retries exceeded: ${errorMsg}`);
          appendEvent(pipelineId, "agent_error_detail", {
            error: errorMsg,
            subtype: "error_during_execution",
            errorType: errorInfo.type,
            retryable: errorInfo.retryable,
            retryCount,
            totalTurns,
          });
          throw error;
        } finally {
          promptStream?.close();
        }
      }

      return { lastAssistantText };
    };

    for (let reqIndex = 0; reqIndex < orderedRequirements.length; reqIndex += 1) {
      if (pausedForUserInput || aborted) {
        break;
      }

      const requirement = orderedRequirements[reqIndex];
      const pipelineState = getPipeline(pipelineId);
      const current = pipelineState?.requirements.find((r) => r.id === requirement.id);
      if (!current) {
        continue;
      }

      if (current.status === "completed" || current.status === "failed") {
        continue;
      }

      let attempt = 0;

      while (attempt < maxAttemptsPerRequirement) {
        if (pausedForUserInput || aborted) {
          break;
        }

        if (isAbortRequested(pipelineId)) {
          aborted = true;
          break;
        }

        attempt += 1;
        const runId = `${pipelineId.slice(0, 8)}-${requirement.id}-a${attempt}`;
        setCurrentRunId(pipelineId, runId);

        const currentReq = getPipeline(pipelineId)?.requirements.find(
          (req) => req.id === requirement.id
        );
        if (!currentReq) {
          break;
        }

        if (currentReq.status === "pending") {
          updateRequirement(pipelineId, requirement.id, "in_progress");
          appendEvent(pipelineId, "requirement_started", {
            requirementId: requirement.id,
          });
          await writeRequirementsSnapshot(pipelineId);
        }

        updatePhase(pipelineId, { current: "planning", requirementIndex: reqIndex });
        appendEvent(pipelineId, "planning_started", {
          requirementId: requirement.id,
          attempt,
        });

        const planPrompt = buildPlanningPrompt(basePrompt, requirement);
        const planResult = await runAgentPhase("planning", planPrompt, "planner");
        appendEvent(pipelineId, "planning_completed", {
          requirementId: requirement.id,
          attempt,
        });

        if (pausedForUserInput || aborted) {
          break;
        }

        const planJson = extractJsonBlock(planResult.lastAssistantText);
        const planText = planJson
          ? JSON.stringify(planJson, null, 2)
          : planResult.lastAssistantText.trim() ||
            JSON.stringify({ requirementId: requirement.id, steps: [] }, null, 2);

        updatePhase(pipelineId, { current: "executing", requirementIndex: reqIndex });
        appendEvent(pipelineId, "executing_started", {
          requirementId: requirement.id,
          attempt,
        });

        const execPrompt = buildExecutionPrompt(basePrompt, requirement, planText);
        await runAgentPhase("executing", execPrompt, "executor");
        appendEvent(pipelineId, "executing_completed", {
          requirementId: requirement.id,
          attempt,
        });

        if (pausedForUserInput || aborted) {
          break;
        }

        updatePhase(pipelineId, { current: "testing", requirementIndex: reqIndex });
        appendEvent(pipelineId, "testing_started", {
          requirementId: requirement.id,
          attempt,
        });

        await ensureRuntimeSkill();
        if (pausedForUserInput || aborted) {
          break;
        }

        const statusBeforeTest = getPipeline(pipelineId)?.requirements.find(
          (req) => req.id === requirement.id
        )?.status;
        const testPrompt = buildTestingPrompt(
          basePrompt,
          requirement,
          resolvedFeaturePrefix,
          pipeline.claudeStorageId || "default",
          runId,
          runtimeSkillRelativePath
        );
        const testResult = await runAgentPhase("testing", testPrompt, "tester");
        appendEvent(pipelineId, "testing_completed", {
          requirementId: requirement.id,
          attempt,
        });

        if (pausedForUserInput || aborted) {
          break;
        }

        const updatedRequirement = getPipeline(pipelineId)?.requirements.find(
          (req) => req.id === requirement.id
        );
        const testStatus = parseTestStatus(testResult.lastAssistantText);
        const completedDuringTest =
          statusBeforeTest !== "completed" && updatedRequirement?.status === "completed";
        const passed = testStatus === "passed" || (testStatus === null && completedDuringTest);

        if (passed) {
          if (updatedRequirement?.status !== "completed") {
            updateRequirement(pipelineId, requirement.id, "completed");
            addCompletedRequirement(pipelineId, requirement.id);
            appendEvent(pipelineId, "requirement_completed", {
              requirementId: requirement.id,
            });
            await writeRequirementsSnapshot(pipelineId);
          }
          break;
        }

        const willRetry = attempt < maxAttemptsPerRequirement;
        appendEvent(pipelineId, "status_update", {
          action: `Tests failed for ${requirement.id}. ${willRetry ? "Retrying" : "Max attempts reached"}.`,
          requirementId: requirement.id,
          phase: "testing",
          statusSource: "system",
        });

        if (!willRetry) {
          updateRequirement(pipelineId, requirement.id, "failed");
          addFailedRequirement(pipelineId, requirement.id);
          appendEvent(pipelineId, "requirement_failed", {
            requirementId: requirement.id,
            reason: "tests_failed",
          });
          await writeRequirementsSnapshot(pipelineId);
        }
      }

      if (pausedForUserInput || aborted) {
        break;
      }
    }
  } finally {
    // Cleanup
    if (!pausedForUserInput) {
      eventBridge.finalize();
    }

    if (enablePlaywright) {
      await closeBrowser();
    }

    markStopped(pipelineId);
  }

  const durationMs = Date.now() - startTime;
  const summary = getRequirementsSummary(pipelineId);

  console.log(`[Harness] Completed in ${durationMs}ms`);
  console.log(`[Harness] ${summary.completed}/${summary.total} requirements completed, ${summary.failed} failed`);

  if (pausedForUserInput) {
    return {
      success: false,
      completedRequirements: pipeline.requirements
        .filter((r) => r.status === "completed")
        .map((r) => r.id),
      failedRequirements: pipeline.requirements
        .filter((r) => r.status === "failed")
        .map((r) => r.id),
      totalTurns,
      durationMs,
      aborted: false,
    };
  }

  // Update pipeline status
  const allProcessed = areAllRequirementsProcessed(pipelineId);
  if (aborted) {
    updateStatus(pipelineId, "aborted");
    appendEvent(pipelineId, "aborted", {});
  } else if (allProcessed) {
    if (summary.failed === 0) {
      updateStatus(pipelineId, "completed");
      appendEvent(pipelineId, "pipeline_completed", {
        totalRequirements: summary.total,
        completed: summary.completed,
        failed: summary.failed,
      });
    } else {
      // Some failed but all processed
      updateStatus(pipelineId, "completed");
      appendEvent(pipelineId, "pipeline_completed", {
        totalRequirements: summary.total,
        completed: summary.completed,
        failed: summary.failed,
        partial: true,
      });
    }
  }

  return {
    success: summary.failed === 0 && !aborted,
    completedRequirements: pipeline.requirements
      .filter((r) => r.status === "completed")
      .map((r) => r.id),
    failedRequirements: pipeline.requirements
      .filter((r) => r.status === "failed")
      .map((r) => r.id),
    totalTurns,
    durationMs,
    aborted,
  };
}
