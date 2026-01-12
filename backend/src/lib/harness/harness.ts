/**
 * Harness
 *
 * Thin wrapper that runs the agent with full autonomy.
 * The agent decides phases, retries, and workflow - harness just provides
 * the environment and handles cleanup.
 */

import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  getPipeline,
  updateStatus,
  appendEvent,
  markRunning,
  markStopped,
  isAbortRequested,
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
  enablePlaywright: boolean
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

  // Add requirements
  prompt += "## Requirements to Implement\n\n";
  prompt += "```json\n";
  prompt += JSON.stringify(requirements, null, 2);
  prompt += "\n```\n\n";

  // Add working directory
  prompt += `## Working Directory\n\n\`${targetProjectPath}\`\n\n`;

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

  console.log(`[Harness] Starting with ${requirements.length} requirements`);
  console.log(`[Harness] Model: ${model}, MaxTurns: ${maxTurns}, Playwright: ${enablePlaywright}`);

  // Mark pipeline as running
  markRunning(pipelineId);
  updateStatus(pipelineId, "running" as any); // Status will be added to pipeline.ts

  const startTime = Date.now();
  let totalTurns = 0;
  let aborted = false;

  // Token tracking for per-step deltas
  let previousInputTokens = 0;
  let previousOutputTokens = 0;

  // Initialize event bridge
  const eventBridge = new EventBridge(pipelineId);

  // Initialize Playwright if enabled
  if (enablePlaywright) {
    await initBrowser();
  }

  try {
    // Load and build prompt
    const fullPrompt = buildPrompt(requirements, targetProjectPath, enablePlaywright);

    appendEvent(pipelineId, "status_update", {
      action: "Starting agent...",
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
                  const toolInput = input.tool_input;

                  // Handle workflow tools
                  if (isWorkflowTool(toolName)) {
                    const result = handleWorkflowTool(
                      pipelineId,
                      toolName as WorkflowToolName,
                      toolInput,
                      eventBridge
                    );
                    return {
                      continue: true,
                      tool_result: result,
                    };
                  }

                  // Handle Playwright tools
                  if (enablePlaywright && toolName.startsWith("web_")) {
                    try {
                      const result = await executePlaywrightTool(
                        toolName,
                        toolInput as Record<string, unknown>
                      );

                      // Emit tool events
                      eventBridge.onToolStart(toolName, toolInput, input.tool_use_id);
                      eventBridge.onToolComplete(toolName, toolInput, input.tool_use_id, result);

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
                      eventBridge.onToolError(toolName, toolInput, input.tool_use_id, errorMsg);
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
                  eventBridge.onToolStart(toolName, toolInput, input.tool_use_id);

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

        // Emit agent_response event with the full content
        const assistantMsg = msg as {
          type: "assistant";
          content?: string;
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        };
        if (assistantMsg.content) {
          appendEvent(pipelineId, "agent_response", {
            content: assistantMsg.content,
            turnNumber: totalTurns,
          });
        }

        // Extract token usage and pass delta to EventBridge for next tool_completed
        if (assistantMsg.message?.usage) {
          const usage = assistantMsg.message.usage;
          const deltaInput = (usage.input_tokens ?? 0) - previousInputTokens;
          const deltaOutput = (usage.output_tokens ?? 0) - previousOutputTokens;
          previousInputTokens = usage.input_tokens ?? 0;
          previousOutputTokens = usage.output_tokens ?? 0;

          eventBridge.setTurnTokenDelta(deltaInput, deltaOutput);
        }
      }

      if (msg.type === "result") {
        const result = msg as SDKResultMessage;
        if (result.subtype === "success") {
          console.log(`[Harness] Agent completed successfully`);

          // Emit token_usage event if available
          if ("usage" in result && result.usage) {
            const usage = result.usage as { input_tokens?: number; output_tokens?: number };
            appendEvent(pipelineId, "token_usage", {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              totalTurns,
            });
          }
        } else if (result.subtype === "error_max_turns") {
          console.log(`[Harness] Agent hit max turns limit (${maxTurns})`);
        } else {
          console.error(`[Harness] Agent error: ${result.subtype}`);
          if ("errors" in result) {
            console.error(`[Harness] Errors: ${result.errors.join(", ")}`);
          }
        }
      }
    }
  } finally {
    // Cleanup
    eventBridge.finalize();

    if (enablePlaywright) {
      await closeBrowser();
    }

    markStopped(pipelineId);
  }

  const durationMs = Date.now() - startTime;
  const summary = getRequirementsSummary(pipelineId);

  console.log(`[Harness] Completed in ${durationMs}ms`);
  console.log(`[Harness] ${summary.completed}/${summary.total} requirements completed, ${summary.failed} failed`);

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
