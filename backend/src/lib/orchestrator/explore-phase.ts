/**
 * Explore Phase
 *
 * Parallel codebase exploration to discover patterns and context.
 */

import {
  type Requirement,
  getPipeline,
  updatePhase,
  updateStatus,
  appendEvent,
} from "../pipeline";
import {
  runParallelExplorers,
  type ParallelExplorationResult,
} from "../parallel-explorer";
import { type ExplorationDepth } from "../model-selector";
import { createToolCallbacks } from "./callbacks";
import { logPhase } from "./utils";

/**
 * Run the exploration phase for a requirement
 * Uses parallel specialized explorers (pattern, API, test) for fast, comprehensive discovery
 */
export async function runExplorePhase(
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
    const status = explorer.error ? `X ${explorer.error}` : `OK ${explorer.duration}ms`;
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
