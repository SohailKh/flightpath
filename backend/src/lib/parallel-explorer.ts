/**
 * Parallel Explorer - Runs multiple specialized explorers in parallel
 *
 * Launches pattern, API, and test explorers concurrently, then merges results
 * and selects the appropriate model for the planning phase.
 */

import { existsSync } from "node:fs";
import {
  runPipelineAgent,
  type ToolEventCallbacks,
  type AgentName,
} from "./agent";
import {
  type ExplorationDepth,
  type MergedExplorationContext,
  type Requirement,
  selectModelForPlanning,
} from "./model-selector";
import { appendEvent } from "./pipeline";
import { createToolCallbacks } from "./orchestrator/callbacks";

// Error types for better retry logic
export type ExplorerErrorType = "configuration" | "authentication" | "model" | "transient" | "unknown";

export interface CategorizedError {
  type: ExplorerErrorType;
  retryable: boolean;
  suggestedAction: string;
}

/**
 * Categorize an error to determine if it's worth retrying and suggest remediation
 */
export function categorizeError(errorMessage: string): ExplorerErrorType {
  const result = categorizeErrorWithDetails(errorMessage);
  return result.type;
}

/**
 * Categorize an error with full details including retry guidance and suggested actions
 */
export function categorizeErrorWithDetails(errorMessage: string): CategorizedError {
  const lowerMsg = errorMessage.toLowerCase();

  // Authentication errors - need user action
  if (
    lowerMsg.includes("not logged in") ||
    lowerMsg.includes("api key") ||
    lowerMsg.includes("unauthorized") ||
    lowerMsg.includes("401")
  ) {
    return {
      type: "authentication",
      retryable: false,
      suggestedAction: "Run 'claude login' to authenticate",
    };
  }

  // Model errors - configuration issue
  if (
    lowerMsg.includes("model not found") ||
    lowerMsg.includes("invalid model") ||
    (lowerMsg.includes("model") && lowerMsg.includes("not available"))
  ) {
    return {
      type: "model",
      retryable: false,
      suggestedAction: "Check model ID is valid. See https://docs.anthropic.com/en/docs/about-claude/models",
    };
  }

  // File/path errors
  const pathErrors = ["not found", "permission denied", "ENOENT", "EACCES"];
  if (pathErrors.some(e => lowerMsg.includes(e.toLowerCase()))) {
    return {
      type: "configuration",
      retryable: false,
      suggestedAction: "Check file paths and permissions",
    };
  }

  // Generic exit code 1 - needs stderr for more info
  if (lowerMsg.includes("exited with code 1")) {
    return {
      type: "configuration",
      retryable: false,
      suggestedAction: "Check agent stderr output for details. May be auth, model, or config issue.",
    };
  }

  // Transient errors - worth retrying
  const transientPatterns = [
    "timeout",
    "ETIMEDOUT",
    "ECONNRESET",
    "rate limit",
    "503",
    "502",
    "overloaded",
  ];
  if (transientPatterns.some(e => lowerMsg.includes(e.toLowerCase()))) {
    return {
      type: "transient",
      retryable: true,
      suggestedAction: "Retry after backoff",
    };
  }

  return {
    type: "unknown",
    retryable: true, // Optimistic retry for unknown errors
    suggestedAction: "Check logs for more details",
  };
}

export type ExplorerType = "pattern" | "api" | "test";

export interface PatternDiscovery {
  name: string;
  files: string[];
  description: string;
}

export interface TestPattern {
  name: string;
  file: string;
}

export interface ExplorerResult {
  type: ExplorerType;
  patterns: PatternDiscovery[];
  relatedFiles: {
    templates: string[];
    types: string[];
    tests: string[];
  };
  apiEndpoints: string[];
  testPatterns: TestPattern[];
  notes: string[];
  duration: number;
  model: string;
  error?: string;
  errorType?: ExplorerErrorType;
}

export interface ParallelExplorationResult {
  requirementId: string;
  explorers: ExplorerResult[];
  merged: MergedExplorationContext;
  totalDuration: number;
  selectedModel: string;
  complexityScore: number;
}

// Map explorer type to agent name
const EXPLORER_AGENTS: Record<ExplorerType, AgentName> = {
  pattern: "explorer-pattern",
  api: "explorer-api",
  test: "explorer-test",
};

/**
 * Parse explorer output to extract structured results
 */
function parseExplorerOutput(
  type: ExplorerType,
  output: string,
  duration: number
): ExplorerResult {
  const result: ExplorerResult = {
    type,
    patterns: [],
    relatedFiles: { templates: [], types: [], tests: [] },
    apiEndpoints: [],
    testPatterns: [],
    notes: [],
    duration,
    model: "haiku",
  };

  try {
    // Try to extract JSON from the output
    const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);

      result.patterns = parsed.patterns || [];
      result.relatedFiles = parsed.relatedFiles || result.relatedFiles;
      result.apiEndpoints = parsed.apiEndpoints || [];
      result.testPatterns = parsed.testPatterns || [];
      result.notes = parsed.notes || [];
    } else {
      // Try direct JSON parse
      const directJson = output.match(/\{[\s\S]*"type"[\s\S]*\}/);
      if (directJson) {
        const parsed = JSON.parse(directJson[0]);
        result.patterns = parsed.patterns || [];
        result.relatedFiles = parsed.relatedFiles || result.relatedFiles;
        result.apiEndpoints = parsed.apiEndpoints || [];
        result.testPatterns = parsed.testPatterns || [];
        result.notes = parsed.notes || [];
      }
    }
  } catch {
    // If JSON parsing fails, extract what we can from text
    result.notes.push("Failed to parse structured output");

    // Extract file paths mentioned
    const filePaths = output.match(/[a-zA-Z0-9_\-/.]+\.(ts|tsx|js|jsx|json)/g);
    if (filePaths) {
      result.relatedFiles.templates = [...new Set(filePaths)].slice(0, 10);
    }
  }

  return result;
}

/**
 * Run a single explorer agent
 */
async function runSingleExplorer(
  pipelineId: string,
  explorerType: ExplorerType,
  requirement: Requirement,
  targetProjectPath: string | undefined,
  _toolCallbacks?: ToolEventCallbacks,
  timeoutMs: number = 60000
): Promise<ExplorerResult> {
  const startTime = Date.now();
  const agentName = EXPLORER_AGENTS[explorerType];

  // Create agent-specific callbacks for this explorer
  const explorerCallbacks = createToolCallbacks(pipelineId, "exploring", agentName);

  const prompt = buildExplorerPrompt(explorerType, requirement);

  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Explorer ${explorerType} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const emitPrompt = (fullPrompt: string) => {
      appendEvent(pipelineId, "agent_prompt", {
        prompt: fullPrompt,
        agentName,
        phase: "exploring",
        explorerType,
        requirementId: requirement.id,
      });
    };

    const result = await Promise.race([
      runPipelineAgent(
        agentName,
        prompt,
        undefined, // No streaming for parallel explorers
        targetProjectPath,
        20, // Max turns - explorers need room to properly explore codebases
        explorerCallbacks,
        undefined,
        undefined,
        emitPrompt
      ),
      timeoutPromise,
    ]);

    const duration = Date.now() - startTime;
    return parseExplorerOutput(explorerType, result.reply, duration);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    const errorType = categorizeError(errorMsg);

    // Log detailed error for debugging (stack trace is logged at agent.ts level)
    console.error(`[Explore] ${explorerType} failed (${errorType}):`, errorMsg);
    console.error(`[Explore] ${explorerType} config: maxTurns=20, timeout=${timeoutMs}ms, model=haiku`);
    console.error(`[Explore] Requirement: ${requirement.id} - ${requirement.title}`);

    return {
      type: explorerType,
      patterns: [],
      relatedFiles: { templates: [], types: [], tests: [] },
      apiEndpoints: [],
      testPatterns: [],
      notes: [],
      duration,
      model: "haiku",
      error: errorMsg,
      errorType,
    };
  }
}

/**
 * Build the prompt for a specific explorer type
 */
function buildExplorerPrompt(
  explorerType: ExplorerType,
  requirement: Requirement
): string {
  const baseContext = `Explore the codebase for requirement: ${requirement.id}

Title: ${requirement.title}
Description: ${requirement.description}

Platform: ${requirement.platform || "backend"}
Area: ${requirement.area || "general"}

Acceptance Criteria:
${requirement.acceptanceCriteria?.map((c) => `- ${c}`).join("\n") || "- None specified"}`;

  switch (explorerType) {
    case "pattern":
      return `${baseContext}

Focus on: File structure, naming conventions, component patterns, directory organization.
Find similar implementations that can serve as templates.`;

    case "api":
      return `${baseContext}

Focus on: API endpoints, type definitions, interfaces, service contracts.
Find relevant types, API routes, and data flow patterns.`;

    case "test":
      return `${baseContext}

Focus on: Test patterns, testing utilities, test organization.
Find example tests that can serve as templates.`;
  }
}

/**
 * Merge results from multiple explorers into a unified context
 */
export function mergeExplorationResults(
  results: ExplorerResult[]
): MergedExplorationContext {
  const merged: MergedExplorationContext = {
    patterns: [],
    relatedFiles: { templates: [], types: [], tests: [] },
    existingComponents: [],
    apiEndpoints: [],
    testPatterns: [],
    notes: [],
  };

  // Track seen items to avoid duplicates
  const seenPatterns = new Set<string>();
  const seenTemplates = new Set<string>();
  const seenTypes = new Set<string>();
  const seenTests = new Set<string>();
  const seenEndpoints = new Set<string>();

  for (const result of results) {
    // Skip failed explorers
    if (result.error) continue;

    // Merge patterns (dedupe by name)
    for (const pattern of result.patterns) {
      if (!seenPatterns.has(pattern.name)) {
        seenPatterns.add(pattern.name);
        merged.patterns.push(pattern);
      }
    }

    // Merge related files (dedupe by path)
    for (const template of result.relatedFiles.templates) {
      if (!seenTemplates.has(template)) {
        seenTemplates.add(template);
        merged.relatedFiles.templates.push(template);
      }
    }

    for (const type of result.relatedFiles.types) {
      if (!seenTypes.has(type)) {
        seenTypes.add(type);
        merged.relatedFiles.types.push(type);
      }
    }

    for (const test of result.relatedFiles.tests) {
      if (!seenTests.has(test)) {
        seenTests.add(test);
        merged.relatedFiles.tests.push(test);
      }
    }

    // Merge API endpoints
    for (const endpoint of result.apiEndpoints) {
      if (!seenEndpoints.has(endpoint)) {
        seenEndpoints.add(endpoint);
        merged.apiEndpoints.push(endpoint);
      }
    }

    // Merge test patterns
    merged.testPatterns.push(...result.testPatterns);

    // Merge notes
    merged.notes.push(...result.notes);
  }

  // Extract components from pattern explorer results
  for (const result of results) {
    if (result.type === "pattern" && !result.error) {
      for (const pattern of result.patterns) {
        if (pattern.name.includes("component") || pattern.name.includes("Component")) {
          merged.existingComponents.push(pattern.name);
        }
      }
    }
  }

  return merged;
}

/**
 * Run parallel explorers for a requirement
 */
export async function runParallelExplorers(
  pipelineId: string,
  requirement: Requirement,
  targetProjectPath: string | undefined,
  depth: ExplorationDepth,
  toolCallbacks?: ToolEventCallbacks
): Promise<ParallelExplorationResult> {
  const explorerTypes: ExplorerType[] = ["pattern", "api", "test"];
  const startTime = Date.now();

  // Validate target project path exists before running explorers
  if (targetProjectPath) {
    if (!existsSync(targetProjectPath)) {
      const error = `Target project path does not exist: ${targetProjectPath}`;
      console.error(`[Explore] Configuration error: ${error}`);
      throw new Error(error);
    }
    console.log(`[Explore] Target project path validated: ${targetProjectPath}`);
  } else {
    console.log(`[Explore] No target project path specified, running in current directory`);
  }

  console.log(`[Explore] Starting parallel exploration: ${explorerTypes.join(", ")}`);

  // Emit start event for each explorer
  for (const type of explorerTypes) {
    console.log(`[Explore] ${type} explorer started`);
    appendEvent(pipelineId, "explorer_started", {
      requirementId: requirement.id,
      explorerType: type,
      model: "haiku",
    });
  }

  // Run all explorers in parallel with Promise.allSettled
  const results = await Promise.allSettled(
    explorerTypes.map((type) =>
      runSingleExplorer(pipelineId, type, requirement, targetProjectPath, toolCallbacks)
    )
  );

  // Process results
  const explorerResults: ExplorerResult[] = results.map((result, index) => {
    const type = explorerTypes[index];

    if (result.status === "fulfilled") {
      return result.value;
    } else {
      // Handle rejected promise
      const errorMsg = result.reason?.message || "Unknown error";
      const errorType = categorizeError(errorMsg);
      return {
        type,
        patterns: [],
        relatedFiles: { templates: [], types: [], tests: [] },
        apiEndpoints: [],
        testPatterns: [],
        notes: [],
        duration: 0,
        model: "haiku",
        error: errorMsg,
        errorType,
      };
    }
  });

  // Emit completion event for each explorer
  for (const result of explorerResults) {
    if (result.error) {
      console.log(`[Explore] ${result.type} failed: ${result.error}`);
      appendEvent(pipelineId, "explorer_error", {
        requirementId: requirement.id,
        explorerType: result.type,
        error: result.error,
        duration: result.duration,
      });
    } else {
      const filesCount = result.relatedFiles.templates.length +
        result.relatedFiles.types.length +
        result.relatedFiles.tests.length;
      console.log(`[Explore] ${result.type} completed in ${result.duration}ms (patterns: ${result.patterns.length}, files: ${filesCount})`);
      appendEvent(pipelineId, "explorer_completed", {
        requirementId: requirement.id,
        explorerType: result.type,
        model: result.model,
        duration: result.duration,
        patternsFound: result.patterns.length,
        filesFound: filesCount,
      });
    }
  }

  // Merge results from successful explorers
  const successfulResults = explorerResults.filter((r) => !r.error);
  const merged = mergeExplorationResults(successfulResults);

  // Check if all explorers failed
  if (successfulResults.length === 0) {
    // Analyze error types to provide better guidance
    const configErrors = explorerResults.filter((r) => r.errorType === "configuration");
    const hasConfigError = configErrors.length > 0;

    const errorDetails = explorerResults.map((r) =>
      `${r.type}: ${r.error} (${r.errorType || "unknown"})`
    ).join(", ");

    const retryAdvice = hasConfigError
      ? " [CONFIG ERROR - Retry will likely fail. Check Claude Code setup and authentication.]"
      : " [May be transient - retry might help]";

    throw new Error(
      `All parallel explorers failed: ${errorDetails}${retryAdvice}`
    );
  }

  // Select model for planning based on merged results
  const { model: selectedModel, score: complexityScore } = selectModelForPlanning(
    requirement,
    merged,
    depth
  );

  console.log(`[Explore] Model selected: ${selectedModel} (complexity: ${complexityScore})`);

  // Emit model selection event
  appendEvent(pipelineId, "model_selected", {
    requirementId: requirement.id,
    selectedModel,
    complexityScore,
    depth,
    successfulExplorers: successfulResults.length,
    failedExplorers: explorerResults.length - successfulResults.length,
  });

  const totalDuration = Date.now() - startTime;

  return {
    requirementId: requirement.id,
    explorers: explorerResults,
    merged,
    totalDuration,
    selectedModel,
    complexityScore,
  };
}

/**
 * Chunk array into groups for parallel processing
 */
export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
