/**
 * Harness
 *
 * Thin wrapper that runs the agent with full autonomy.
 * The agent decides phases, retries, and workflow - harness just provides
 * the environment and handles cleanup.
 */

import { query, type SDKResultMessage, type SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  getPipeline,
  updateStatus,
  appendEvent,
  addArtifact,
  markRunning,
  markStopped,
  isAbortRequested,
  setFeaturePrefix,
  setUserInputRequest,
  type UserInputEntry,
  type Requirement,
} from "../pipeline";
import { EventBridge } from "./event-bridge";
import {
  isWorkflowTool,
  handleWorkflowTool,
  areAllRequirementsProcessed,
  getRequirementsSummary,
  WORKFLOW_TOOL_DEFINITIONS,
  type WorkflowToolName,
} from "./workflow-tools";
import {
  initBrowser,
  closeBrowser,
  executePlaywrightTool,
  formatPlaywrightToolsForPrompt,
} from "../playwright-tools";
import { saveScreenshot } from "../artifacts";
import { rewriteClaudeCommand, rewriteClaudeFilePath } from "../claude-paths";
import { FLIGHTPATH_ROOT, parseRequirementsFromSpec } from "../orchestrator/project-init";
import { notifyTelegramQuestions } from "../telegram";

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

/**
 * Build the full prompt for the agent
 */
function buildPrompt(
  requirements: Requirement[],
  targetProjectPath: string,
  enablePlaywright: boolean,
  featurePrefix: string,
  claudeStorageId: string,
  userInputs: UserInputEntry[]
): string {
  let prompt = ""

  // Add workflow tool definitions
  prompt += WORKFLOW_TOOL_DEFINITIONS + "\n\n";

  // Add Playwright tools if enabled
  if (enablePlaywright) {
    prompt += "## Web Testing Tools (Playwright)\n\n";
    prompt += "You have access to Playwright web testing tools for browser automation:\n\n";
    prompt += formatPlaywrightToolsForPrompt();
    prompt += "\n\n";
  }

  prompt += "## User Input Protocol\n\n";
  prompt += "If you need information from the user to continue, call `AskUserQuestion`.\n";
  prompt += "Only ask questions that are essential to make progress or complete testing, and batch related questions together.\n\n";

  // Add requirements
  prompt += "## Requirements to Implement\n\n";
  prompt += "```json\n";
  prompt += JSON.stringify(requirements, null, 2);
  prompt += "\n```\n\n";

  // Add working directory
  prompt += `## Working Directory\n\n\`${targetProjectPath}\`\n\n`;

  // Add Claude storage ID for artifact storage
  prompt += `## Claude Storage ID\n\n\`${claudeStorageId}\`\n\n`;
  prompt += `Use this ID when running playwright scripts:\n`;
  prompt += `\`\`\`bash\nCLAUDE_STORAGE_ID="${claudeStorageId}"\n\`\`\`\n\n`;

  // Add Claude logs context
  prompt += "## Claude Logs\n\n";
  prompt += `If present, read these for context and treat them as read-only:\n\n`;
  prompt += `- \`.claude/${featurePrefix}/claude-progress.md\`\n`;
  prompt += `- \`.claude/${featurePrefix}/events.ndjson\`\n\n`;

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

  // Add start instruction
  prompt += "## Start\n\n";
  prompt += "Begin with the first pending requirement. Call `start_requirement` to begin.\n";

  return prompt;
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

  console.log(`[Harness] Starting with ${requirements.length} requirements`);
  console.log(`[Harness] Model: ${model}, MaxTurns: ${maxTurns}, Playwright: ${enablePlaywright}`);

  // Mark pipeline as running
  markRunning(pipelineId);
  updateStatus(pipelineId, "running" as any); // Status will be added to pipeline.ts

  const startTime = Date.now();
  let totalTurns = 0;
  let aborted = false;
  let pausedForUserInput = false;

  // Token tracking for per-step deltas
  let previousInputTokens = 0;
  let previousOutputTokens = 0;

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

  try {
    // Load and build prompt
    const fullPrompt = buildPrompt(
      requirements,
      targetProjectPath,
      enablePlaywright,
      resolvedFeaturePrefix,
      pipeline.claudeStorageId || "default",
      pipeline.userInputLog ?? []
    );
    appendEvent(pipelineId, "agent_prompt", {
      prompt: fullPrompt,
      agentName: "harness",
    });

    appendEvent(pipelineId, "status_update", {
      action: "Starting agent...",
      statusSource: "system",
    });

    // Run the agent
    const q = query({
      prompt: fullPrompt,
      options: {
        maxTurns,
        model,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: targetProjectPath,
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

                  // Handle workflow tools
                  if (isWorkflowTool(toolName)) {
                    const result = handleWorkflowTool(
                      pipelineId,
                      toolName as WorkflowToolName,
                      resolvedInput,
                      eventBridge
                    );
                    return {
                      continue: true,
                      tool_result: result,
                    };
                  }

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
                    // Don't double-emit for workflow or playwright tools
                    if (!isWorkflowTool(input.tool_name) && !input.tool_name.startsWith("web_")) {
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
      },
    });

    // Process agent messages
    for await (const msg of q) {
      if (msg.type === "assistant") {
        totalTurns++;
        console.log(`[Harness] Turn ${totalTurns}/${maxTurns}`);

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
