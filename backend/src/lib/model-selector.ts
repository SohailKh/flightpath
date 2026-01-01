/**
 * Model selection based on requirement complexity and exploration depth
 */

export type ExplorationDepth = "quick" | "medium" | "thorough";

export interface ComplexityFactors {
  /** Length of requirement text (description + acceptance criteria) */
  textLength: number;
  /** Estimated number of files to modify */
  estimatedFiles: number;
  /** Platform scope */
  platformScope: "mobile" | "backend" | "both";
  /** Whether novel patterns need to be created (no existing templates found) */
  hasNovelPatterns: boolean;
  /** Number of cross-module dependencies */
  crossModuleDependencies: number;
}

export interface MergedExplorationContext {
  patterns: Array<{
    name: string;
    files: string[];
    description: string;
  }>;
  relatedFiles: {
    templates: string[];
    types: string[];
    tests: string[];
  };
  existingComponents: string[];
  apiEndpoints: string[];
  testPatterns: Array<{
    name: string;
    file: string;
  }>;
  notes: string[];
}

export interface Requirement {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  platform?: "mobile" | "backend" | "both";
  area?: string;
}

// Model identifiers
const MODELS = {
  haiku: "claude-haiku-3-5-20241022",
  sonnet: "claude-sonnet-4-5-20250929",
  opus: "claude-opus-4-20250514",
} as const;

/**
 * Analyze requirement complexity from requirement and exploration context
 */
export function analyzeComplexity(
  requirement: Requirement,
  explorationContext: MergedExplorationContext
): ComplexityFactors {
  // Calculate text length from requirement
  const textLength =
    requirement.description.length +
    requirement.acceptanceCriteria.join("").length +
    (requirement.title?.length || 0);

  // Estimate files from exploration results
  const estimatedFiles =
    explorationContext.relatedFiles.templates.length +
    explorationContext.relatedFiles.types.length +
    Math.ceil(explorationContext.relatedFiles.tests.length / 2); // Tests usually match source files

  // Determine platform scope
  const platformScope = requirement.platform || "backend";

  // Novel patterns = no templates found
  const hasNovelPatterns = explorationContext.patterns.length === 0;

  // Cross-module dependencies based on unique directories in related files
  const directories = new Set<string>();
  [
    ...explorationContext.relatedFiles.templates,
    ...explorationContext.relatedFiles.types,
  ].forEach((file) => {
    const parts = file.split("/");
    if (parts.length >= 2) {
      directories.add(parts.slice(0, -1).join("/"));
    }
  });
  const crossModuleDependencies = Math.max(0, directories.size - 1);

  return {
    textLength,
    estimatedFiles,
    platformScope,
    hasNovelPatterns,
    crossModuleDependencies,
  };
}

/**
 * Calculate complexity score from factors (0-100)
 */
export function calculateComplexityScore(factors: ComplexityFactors): number {
  let score = 0;

  // Text length (0-20 points)
  // 500+ chars = 20 points
  score += Math.min(20, Math.floor(factors.textLength / 25));

  // File count (0-25 points)
  // 10+ files = 25 points
  score += Math.min(25, factors.estimatedFiles * 2.5);

  // Platform scope (0-20 points)
  if (factors.platformScope === "both") {
    score += 20;
  } else if (factors.platformScope === "mobile") {
    score += 10; // Mobile is often more complex than backend
  }

  // Novel patterns (0-15 points)
  if (factors.hasNovelPatterns) {
    score += 15;
  }

  // Cross-module dependencies (0-20 points)
  // 5+ modules = 20 points
  score += Math.min(20, factors.crossModuleDependencies * 4);

  return Math.round(score);
}

/**
 * Select the appropriate model based on complexity and depth
 */
export function selectModel(
  factors: ComplexityFactors,
  depth: ExplorationDepth
): string {
  // Quick depth always uses Haiku for speed
  if (depth === "quick") {
    return MODELS.haiku;
  }

  // Thorough depth always uses Opus for best quality
  if (depth === "thorough") {
    return MODELS.opus;
  }

  // Medium depth uses score-based selection
  const score = calculateComplexityScore(factors);

  if (score < 30) {
    return MODELS.haiku;
  } else if (score < 70) {
    return MODELS.sonnet;
  } else {
    return MODELS.opus;
  }
}

/**
 * Select model for planning phase based on exploration results
 */
export function selectModelForPlanning(
  requirement: Requirement,
  explorationContext: MergedExplorationContext,
  depth: ExplorationDepth
): { model: string; score: number; factors: ComplexityFactors } {
  const factors = analyzeComplexity(requirement, explorationContext);
  const score = calculateComplexityScore(factors);
  const model = selectModel(factors, depth);

  return { model, score, factors };
}

/**
 * Get human-readable model name
 */
export function getModelDisplayName(modelId: string): string {
  if (modelId.includes("haiku")) return "Haiku";
  if (modelId.includes("sonnet")) return "Sonnet";
  if (modelId.includes("opus")) return "Opus";
  return modelId;
}
