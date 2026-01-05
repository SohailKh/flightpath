/**
 * Test Phase
 *
 * Runs tests and verifies implementation against acceptance criteria.
 */

import {
  type Requirement,
  getPipeline,
  updatePhase,
  updateStatus,
  appendEvent,
  addArtifact,
} from "../pipeline";
import { runPipelineAgent, type PipelineAgentResult } from "../agent";
import { saveScreenshot, saveTestResult } from "../artifacts";
import { startDevServers, stopDevServers, type ServerHandle } from "../dev-server";
import { captureWebScreenshot, closeBrowser } from "../screenshot";
import { createToolCallbacks, createServerLogCallbacks, emitTodoEvents } from "./callbacks";
import { LOG, logPhase } from "./utils";

/**
 * Test verdict with confidence level
 */
export interface TestVerdict {
  passed: boolean;
  confidence: "explicit" | "inferred" | "unknown";
  reason: string;
}

/**
 * Run the testing phase for a requirement
 * Returns true if tests passed
 */
export async function runTestPhase(
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

    // Emit todo events if agent returned todos in structured output
    emitTodoEvents(pipelineId, "testing", result.structuredOutput);

    logPhase("test", "Testing completed", `${requirement.id}`);

    appendEvent(pipelineId, "agent_message", {
      phase: "testing",
      content: result.reply,
      streaming: false,
    });

    // Determine if tests passed based on agent output
    const verdict = determineTestResult(result);

    // Log the verdict with confidence level
    console.log(`${LOG.test} Verdict: ${verdict.passed ? "PASSED" : "FAILED"} (${verdict.confidence}) - ${verdict.reason}`);

    // Save test result artifact with verdict details
    const testResult = {
      requirementId: requirement.id,
      passed: verdict.passed,
      confidence: verdict.confidence,
      reason: verdict.reason,
      timestamp: new Date().toISOString(),
      criteria: requirement.acceptanceCriteria.map((c) => ({
        criterion: c,
        passed: verdict.passed,
      })),
      failureReason: verdict.passed ? undefined : extractFailureReason(result),
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

    if (verdict.passed) {
      appendEvent(pipelineId, "test_passed", {
        requirementId: requirement.id,
        confidence: verdict.confidence,
      });
    } else {
      appendEvent(pipelineId, "test_failed", {
        requirementId: requirement.id,
        reason: extractFailureReason(result),
        confidence: verdict.confidence,
      });
    }

    appendEvent(pipelineId, "testing_completed", {
      requirementId: requirement.id,
      passed: verdict.passed,
      confidence: verdict.confidence,
    });

    return verdict.passed;
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
 * Returns a verdict with confidence level. Defaults to FAILED for safety.
 */
function determineTestResult(result: PipelineAgentResult): TestVerdict {
  const reply = result.reply.toLowerCase();

  // Check for explicit success indicators
  const successPatterns = [
    "all tests passed",
    "tests passed",
    "implementation verified",
    "acceptance criteria met",
    "test: passed",
    "result: pass"
  ];

  for (const pattern of successPatterns) {
    if (reply.includes(pattern)) {
      return {
        passed: true,
        confidence: "explicit",
        reason: `Found success indicator: "${pattern}"`
      };
    }
  }

  // Check for explicit failure indicators
  const failurePatterns = [
    "test failed",
    "tests failed",
    "acceptance criteria not met",
    "issues found",
    "test: failed",
    "result: fail",
    "error:",
    "assertion failed"
  ];

  for (const pattern of failurePatterns) {
    if (reply.includes(pattern)) {
      return {
        passed: false,
        confidence: "explicit",
        reason: `Found failure indicator: "${pattern}"`
      };
    }
  }

  // No clear indicator - DEFAULT TO FAILED (safer than defaulting to passed)
  console.log(`${LOG.test} Result determination: passed=false (no clear indicator, defaulting to FAILED for safety)`);
  return {
    passed: false,
    confidence: "unknown",
    reason: "No explicit pass/fail indicator found - treating as failure for safety"
  };
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
