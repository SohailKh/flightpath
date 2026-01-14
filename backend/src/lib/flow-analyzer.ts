/**
 * Flow Analyzer - Analyzes pipeline runs and generates improvement suggestions
 * using Claude API to provide actionable feedback.
 */

import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Pipeline, PipelineEvent, Requirement } from "./pipeline";
import { buildClaudeCodeOptions, createPromptStream } from "./claude-query";

export interface AnalysisMetadata {
  analyzedAt: string;
  pipelineId: string;
  toolCallCount: number;
  errorCount: number;
  retryCount: number;
  duration: string;
  phases: string[];
}

export interface FlowAnalysisResult {
  suggestions: string;
  claudeCodePrompt: string;
  contextData: string;
  metadata: AnalysisMetadata;
}

interface ToolCallSummary {
  name: string;
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
  errorCount: number;
  samples: Array<{ input: unknown; durationMs?: number; error?: string }>;
}

interface PhaseTiming {
  phase: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

interface SerializedFlowData {
  summary: {
    pipelineId: string;
    status: string;
    currentPhase: string;
    totalRequirements: number;
    completedRequirements: number;
    failedRequirements: number;
    retryCount: number;
    initialPrompt: string;
  };
  requirements: Array<{
    id: string;
    title: string;
    status: string;
    acceptanceCriteria: string[];
  }>;
  toolCalls: ToolCallSummary[];
  errors: Array<{
    type: string;
    timestamp: string;
    toolName?: string;
    error?: string;
    data?: unknown;
  }>;
  phaseTiming: PhaseTiming[];
  agentsUsed: string[];
  conversationSummary: string;
}

/**
 * Extract tool call statistics from pipeline events
 */
function extractToolCalls(events: PipelineEvent[]): ToolCallSummary[] {
  const toolStats = new Map<string, ToolCallSummary>();
  const toolStartTimes = new Map<string, { ts: string; input: unknown }>();

  for (const event of events) {
    if (event.type === "tool_started") {
      const toolName = event.data.toolName as string;
      const toolUseId = event.data.toolUseId as string;
      toolStartTimes.set(toolUseId, { ts: event.ts, input: event.data.toolInput });

      if (!toolStats.has(toolName)) {
        toolStats.set(toolName, {
          name: toolName,
          count: 0,
          totalDurationMs: 0,
          avgDurationMs: 0,
          errorCount: 0,
          samples: [],
        });
      }
      const stat = toolStats.get(toolName)!;
      stat.count++;
    }

    if (event.type === "tool_completed") {
      const toolName = event.data.toolName as string;
      const toolUseId = event.data.toolUseId as string;
      const durationMs = event.data.durationMs as number;
      const startInfo = toolStartTimes.get(toolUseId);

      const stat = toolStats.get(toolName);
      if (stat) {
        stat.totalDurationMs += durationMs || 0;
        stat.avgDurationMs = stat.totalDurationMs / stat.count;

        // Keep first 3 samples for context
        if (stat.samples.length < 3 && startInfo) {
          stat.samples.push({ input: startInfo.input, durationMs });
        }
      }
      toolStartTimes.delete(toolUseId);
    }

    if (event.type === "tool_error") {
      const toolName = event.data.toolName as string;
      const toolUseId = event.data.toolUseId as string;
      const startInfo = toolStartTimes.get(toolUseId);

      const stat = toolStats.get(toolName);
      if (stat) {
        stat.errorCount++;
        if (stat.samples.length < 3 && startInfo) {
          stat.samples.push({
            input: startInfo.input,
            error: event.data.error as string,
          });
        }
      }
      toolStartTimes.delete(toolUseId);
    }
  }

  return Array.from(toolStats.values()).sort((a, b) => b.count - a.count);
}

/**
 * Extract error events from pipeline
 */
function extractErrors(
  events: PipelineEvent[]
): Array<{ type: string; timestamp: string; toolName?: string; error?: string; data?: unknown }> {
  return events
    .filter(
      (e) =>
        e.type === "tool_error" ||
        e.type === "pipeline_failed" ||
        e.type === "requirement_failed" ||
        e.type === "test_failed" ||
        e.type === "server_error"
    )
    .map((e) => ({
      type: e.type,
      timestamp: e.ts,
      toolName: e.data.toolName as string | undefined,
      error: (e.data.error || e.data.message) as string | undefined,
      data: e.data,
    }));
}

/**
 * Extract phase timing from events
 */
function extractPhaseTiming(events: PipelineEvent[]): PhaseTiming[] {
  const phases = ["qa", "planning", "executing", "testing"];
  const timing: PhaseTiming[] = [];

  for (const phase of phases) {
    const startEvent = events.find((e) => e.type === `${phase}_started`);
    const completedEvent = events.find((e) => e.type === `${phase}_completed`);

    if (startEvent) {
      const phaseTiming: PhaseTiming = {
        phase,
        startedAt: startEvent.ts,
        completedAt: completedEvent?.ts,
      };

      if (startEvent && completedEvent) {
        phaseTiming.durationMs =
          new Date(completedEvent.ts).getTime() - new Date(startEvent.ts).getTime();
      }

      timing.push(phaseTiming);
    }
  }

  return timing;
}

/**
 * Extract agents used from events
 */
function extractAgentsUsed(events: PipelineEvent[]): string[] {
  const phases = new Set<string>();

  for (const event of events) {
    if (event.type.endsWith("_started")) {
      const phase = event.type.replace("_started", "");
      if (["qa", "planning", "executing", "testing"].includes(phase)) {
        phases.add(`feature-${phase === "qa" ? "qa" : phase === "planning" ? "planner" : phase === "executing" ? "executor" : "tester"}`);
      }
    }
  }

  return Array.from(phases);
}

/**
 * Summarize conversation history
 */
function summarizeConversation(
  history: Array<{ role: "user" | "assistant"; content: string }>
): string {
  if (history.length === 0) return "No conversation recorded.";

  const userMessages = history.filter((m) => m.role === "user").length;
  const assistantMessages = history.filter((m) => m.role === "assistant").length;

  // Get first user message as context
  const firstUserMessage = history.find((m) => m.role === "user")?.content || "";
  const truncatedFirst =
    firstUserMessage.length > 200
      ? firstUserMessage.slice(0, 200) + "..."
      : firstUserMessage;

  return `${userMessages} user messages, ${assistantMessages} assistant messages. Initial request: "${truncatedFirst}"`;
}

/**
 * Calculate total pipeline duration
 */
function calculateDuration(events: PipelineEvent[]): string {
  if (events.length < 2) return "N/A";

  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const durationMs = new Date(lastEvent.ts).getTime() - new Date(firstEvent.ts).getTime();

  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${(durationMs / 60000).toFixed(1)}min`;
}

/**
 * Serialize pipeline data for analysis
 */
function serializeForAnalysis(pipeline: Pipeline): SerializedFlowData {
  const completedReqs = pipeline.requirements.filter((r) => r.status === "completed").length;
  const failedReqs = pipeline.requirements.filter((r) => r.status === "failed").length;

  return {
    summary: {
      pipelineId: pipeline.id,
      status: pipeline.status,
      currentPhase: pipeline.phase.current,
      totalRequirements: pipeline.phase.totalRequirements,
      completedRequirements: completedReqs,
      failedRequirements: failedReqs,
      retryCount: pipeline.phase.retryCount,
      initialPrompt: pipeline.input.initialPrompt,
    },
    requirements: pipeline.requirements.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      acceptanceCriteria: r.acceptanceCriteria,
    })),
    toolCalls: extractToolCalls(pipeline.events),
    errors: extractErrors(pipeline.events),
    phaseTiming: extractPhaseTiming(pipeline.events),
    agentsUsed: extractAgentsUsed(pipeline.events),
    conversationSummary: summarizeConversation(pipeline.conversationHistory),
  };
}

/**
 * Build the analysis prompt for Claude
 */
function buildAnalysisPrompt(data: SerializedFlowData): string {
  return `You are analyzing a Flightpath pipeline execution to provide improvement suggestions.

## Pipeline Context

${JSON.stringify(data, null, 2)}

## Analysis Instructions

Analyze this pipeline run and provide actionable feedback in the following format:

### 1. Output Analysis
- Was the pipeline successful? Partial success?
- What was achieved vs. what was expected?
- Any quality issues observed?

### 2. Tool Call Patterns
- Which tools were used most/least?
- Any redundant or repeated tool calls?
- Any missing tool calls that would have helped?
- Efficiency observations (unnecessary reads, excessive retries)

### 3. Skills Assessment
- Which agents were used effectively?
- What agents/skills are missing that would help?
- Would a custom skill for this domain help?

### 4. Potential Improvements
- Could a new MCP tool help with common operations?
- Could a new skill automate repeated patterns?
- Could a new agent type help with this workflow?
- Configuration or prompt changes that would help?

### 5. Concrete Suggestions
Provide 3-5 specific, actionable suggestions. For each:
- **What to change**: Describe the change
- **Why it would help**: Expected benefit
- **Impact**: High / Medium / Low

### 6. Claude Code Implementation Prompt
Generate a ready-to-use prompt that could be sent to Claude Code to implement the top improvement suggestion. This prompt should:
- Be self-contained with all necessary context
- Include specific file paths if relevant
- Be actionable and implementable

Format your response as markdown with clear sections.`;
}

/**
 * Generate Claude Code prompt from analysis result
 */
function generateClaudeCodePrompt(
  data: SerializedFlowData,
  suggestions: string
): string {
  // Extract the implementation prompt section if present
  const implementationMatch = suggestions.match(
    /### 6\. Claude Code Implementation Prompt\n([\s\S]*?)(?=\n###|\n## |$)/
  );
  const implementationSection = implementationMatch?.[1]?.trim() || "";

  return `# Flightpath Pipeline Improvement Task

## Context
This task is based on analysis of a Flightpath pipeline run.

**Pipeline Status**: ${data.summary.status}
**Initial Prompt**: ${data.summary.initialPrompt}
**Requirements**: ${data.summary.completedRequirements}/${data.summary.totalRequirements} completed
**Retry Count**: ${data.summary.retryCount}

## Tools Used
${data.toolCalls.map((t) => `- ${t.name}: ${t.count} calls, avg ${t.avgDurationMs.toFixed(0)}ms, ${t.errorCount} errors`).join("\n")}

## Errors Encountered
${data.errors.length > 0 ? data.errors.map((e) => `- [${e.type}] ${e.error || "No message"}`).join("\n") : "No errors"}

## Suggested Improvement
${implementationSection || "See the full analysis for improvement suggestions."}

## Files to Consider
- backend/src/lib/orchestrator.ts - Pipeline orchestration logic
- backend/src/lib/agent.ts - Agent execution and tool callbacks
- backend/src/agents/*.md - Agent prompt definitions
- ui/src/components/*.tsx - UI components`;
}

/**
 * Run analysis agent to get suggestions
 */
async function runAnalysisAgent(prompt: string): Promise<string> {
  let resultText = "";

  const promptStream = createPromptStream(prompt);
  const q = query({
    prompt: promptStream.prompt,
    options: buildClaudeCodeOptions({
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPromptAppend: "Analysis mode. Respond directly without calling tools.",
    }),
  });

  try {
    for await (const msg of q) {
      if (msg.type === "result") {
        promptStream.close();
        const result = msg as SDKResultMessage;
        if (result.subtype === "success") {
          resultText = result.result;
        } else {
          throw new Error(
            `Analysis agent error: ${result.subtype}${
              "errors" in result ? ` - ${result.errors.join(", ")}` : ""
            }`
          );
        }
      }
    }
  } finally {
    promptStream.close();
  }
  return resultText || "No analysis generated.";
}

/**
 * Analyze a pipeline and generate improvement suggestions
 */
export async function analyzeFlow(pipeline: Pipeline): Promise<FlowAnalysisResult> {
  // Serialize pipeline data
  const data = serializeForAnalysis(pipeline);
  const contextData = JSON.stringify(data, null, 2);

  // Build and run analysis prompt
  const analysisPrompt = buildAnalysisPrompt(data);
  const suggestions = await runAnalysisAgent(analysisPrompt);

  // Generate Claude Code prompt
  const claudeCodePrompt = generateClaudeCodePrompt(data, suggestions);

  // Build metadata
  const metadata: AnalysisMetadata = {
    analyzedAt: new Date().toISOString(),
    pipelineId: pipeline.id,
    toolCallCount: data.toolCalls.reduce((sum, t) => sum + t.count, 0),
    errorCount: data.errors.length,
    retryCount: data.summary.retryCount,
    duration: calculateDuration(pipeline.events),
    phases: data.phaseTiming.map((p) => p.phase),
  };

  return {
    suggestions,
    claudeCodePrompt,
    contextData,
    metadata,
  };
}
