/**
 * Project Initialization
 *
 * Handles target project creation and feature spec parsing.
 */

import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { type Requirement, type Epic } from "../pipeline";
import { getClaudeFeaturePath } from "../claude-paths";
import { ensureProjectClaudeLayout } from "../claude-scaffold";

const execAsync = promisify(exec);

/**
 * Generate a fallback ID when one is not provided
 */
function generateFallbackId(prefix: string, index: number): string {
  return `${prefix}-${index + 1}`;
}

/**
 * Convert priority value to a number.
 * Handles both numeric values and MoSCoW string values.
 * Returns 0 if the value cannot be converted.
 */
function parsePriority(value: unknown): number {
  // Already a number
  if (typeof value === "number" && !isNaN(value)) {
    return value;
  }

  // String number (e.g., "1", "2")
  if (typeof value === "string") {
    const numericValue = Number(value);
    if (!isNaN(numericValue)) {
      return numericValue;
    }

    // MoSCoW priority strings
    const normalized = value.toLowerCase().trim();
    const moscowMap: Record<string, number> = {
      must: 1,
      "must have": 1,
      "must-have": 1,
      should: 2,
      "should have": 2,
      "should-have": 2,
      could: 3,
      "could have": 3,
      "could-have": 3,
      wont: 4,
      "won't": 4,
      "wont have": 4,
      "won't have": 4,
      "wont-have": 4,
      "won't-have": 4,
      low: 5,
    };

    if (normalized in moscowMap) {
      return moscowMap[normalized];
    }
  }

  return 0;
}

/**
 * Validate that all IDs in a collection are unique
 * Logs a warning if duplicates are found
 */
function validateUniqueIds(items: Array<{ id: string }>, type: string): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      duplicates.push(item.id);
    }
    seen.add(item.id);
  }
  if (duplicates.length > 0) {
    console.warn(`[project-init] Duplicate ${type} IDs found: ${duplicates.join(", ")}`);
  }
}

// Flightpath root directory - resolved at module load time so it doesn't change
// when agents run with a different cwd (targetProjectPath)
export const FLIGHTPATH_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/**
 * Get the root directory for generated projects.
 * Supports FLIGHTPATH_PROJECTS_DIR env var for Docker/containerized environments.
 */
function getProjectsRoot(): string {
  return process.env.FLIGHTPATH_PROJECTS_DIR || join(homedir(), "flightpath-projects");
}

/**
 * Sanitize a project name for use in directory paths
 * Converts to lowercase, replaces spaces with hyphens, removes special chars
 */
export function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "untitled-project";
}

/**
 * Generate the target project path from a project name
 */
export function generateTargetProjectPath(projectName: string): string {
  const sanitized = sanitizeProjectName(projectName);
  return join(getProjectsRoot(), sanitized);
}

/**
 * Generate a staging project path for new pipelines before feature name is known
 */
export function generateStagingProjectPath(pipelineId: string): string {
  const sanitized = sanitizeProjectName(`fp-staging-${pipelineId}`);
  return join(getProjectsRoot(), sanitized);
}

/**
 * Get the pipeline directory path for a given feature prefix
 */
export function getProjectPipelinePath(featurePrefix: string): string {
  return `.claude/${featurePrefix}`;
}

/**
 * Initialize the target project directory and copy feature spec
 *
 * Creates the .claude directory in backend/.claude/{claudeStorageId}/{featurePrefix}/
 * and seeds .claude settings/skills in the target project.
 */
export async function initializeTargetProject(
  targetPath: string,
  claudeStorageId: string,
  featurePrefix: string = "pipeline",
  sourceRoot?: string,
  cleanupSource?: boolean
): Promise<void> {
  const { mkdir, copyFile, unlink, readdir, rmdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  // Create .claude directory in BACKEND (not in target project)
  const claudeDir = getClaudeFeaturePath(claudeStorageId, featurePrefix);
  await mkdir(claudeDir, { recursive: true });

  // Create target directory
  await mkdir(targetPath, { recursive: true });
  await ensureProjectClaudeLayout(targetPath);

  // Initialize git repository so agent commits go to the right place
  await execAsync("git init", { cwd: targetPath });
  console.log(`[Orchestrator] Initialized git repository at ${targetPath}`);

  const targetSmoke = join(claudeDir, "smoke-tests.json");

  const specRoot = sourceRoot ? resolve(sourceRoot) : FLIGHTPATH_ROOT;
  const fallbackSmoke = join(
    targetPath,
    ".claude",
    featurePrefix,
    "smoke-tests.json"
  );

  // Copy feature spec (check for both new and legacy formats)
  const specFileNames = ["feature-spec.json", "feature-spec.v3.json"];
  let specCopied = false;

  for (const specFileName of specFileNames) {
    const targetSpec = join(claudeDir, specFileName);
    if (existsSync(targetSpec)) {
      specCopied = true;
      break;
    }

    const sourceSpec = join(specRoot, ".claude", featurePrefix, specFileName);
    const fallbackSpec = join(targetPath, ".claude", featurePrefix, specFileName);

    if (existsSync(sourceSpec)) {
      await copyFile(sourceSpec, targetSpec);
      console.log(`[Orchestrator] Copied feature spec to ${targetSpec}`);
      specCopied = true;
      break;
    } else if (existsSync(fallbackSpec)) {
      await copyFile(fallbackSpec, targetSpec);
      console.log(`[Orchestrator] Copied feature spec from target project to ${targetSpec}`);
      specCopied = true;
      break;
    }
  }

  if (!specCopied) {
    console.warn(`[Orchestrator] Feature spec not found for prefix ${featurePrefix}`);
  }

  if (!existsSync(targetSmoke)) {
    const sourceSmoke = join(specRoot, ".claude", featurePrefix, "smoke-tests.json");
    if (existsSync(sourceSmoke)) {
      await copyFile(sourceSmoke, targetSmoke);
      console.log(`[Orchestrator] Copied smoke tests to ${targetSmoke}`);
    } else if (existsSync(fallbackSmoke)) {
      await copyFile(fallbackSmoke, targetSmoke);
      console.log(`[Orchestrator] Copied smoke tests from target project to ${targetSmoke}`);
    }
  }

  if (cleanupSource && sourceRoot) {
    const sourceFeatureDir = join(specRoot, ".claude", featurePrefix);
    const sourceClaudeDir = join(specRoot, ".claude");
    const filesToRemove = [
      join(sourceFeatureDir, "feature-spec.json"),
      join(sourceFeatureDir, "feature-spec.v3.json"),
      join(sourceFeatureDir, "smoke-tests.json"),
      join(sourceClaudeDir, "feature-understanding.json"),
      join(sourceClaudeDir, "feature-map.json"),
    ];

    for (const filePath of filesToRemove) {
      if (existsSync(filePath)) {
        try {
          await unlink(filePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    try {
      if (existsSync(sourceFeatureDir)) {
        const entries = await readdir(sourceFeatureDir);
        if (entries.length === 0) {
          await rmdir(sourceFeatureDir);
        }
      }

      const sourceClaudeRoot = join(specRoot, ".claude");
      if (existsSync(sourceClaudeRoot)) {
        const rootEntries = await readdir(sourceClaudeRoot);
        if (rootEntries.length === 0) {
          await rmdir(sourceClaudeRoot);
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

export interface ParsedFeatureSpec {
  requirements: Requirement[];
  epics: Epic[];
  projectName: string;
  featurePrefix: string;
}

// Spec file names in order of preference (new format first, then legacy)
const SPEC_FILE_NAMES = ["feature-spec.json", "feature-spec.v3.json"];

/**
 * Find the feature spec file in any .claude/{prefix}/ folder
 * Looks for both new (feature-spec.json) and legacy (feature-spec.v3.json) formats
 */
async function findFeatureSpecPath(
  rootPath?: string,
  featurePrefix?: string
): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  const baseRoot = rootPath ? resolve(rootPath) : FLIGHTPATH_ROOT;
  const claudeDir = join(baseRoot, ".claude");
  if (!existsSync(claudeDir)) return null;

  if (featurePrefix) {
    for (const specFileName of SPEC_FILE_NAMES) {
      const specPath = join(claudeDir, featurePrefix, specFileName);
      if (existsSync(specPath)) return specPath;
    }
    return null;
  }

  try {
    const entries = await readdir(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "skills") {
        for (const specFileName of SPEC_FILE_NAMES) {
          const specPath = join(claudeDir, entry.name, specFileName);
          if (existsSync(specPath)) {
            return specPath;
          }
        }
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Parse requirements, epics, and project name from the feature spec file
 */
export async function parseRequirementsFromSpec(
  rootPath?: string,
  featurePrefix?: string
): Promise<ParsedFeatureSpec> {
  try {
    const { readFile } = await import("node:fs/promises");

    const specPath = await findFeatureSpecPath(rootPath, featurePrefix);

    if (!specPath) {
      console.warn("Feature spec not found in any .claude/{prefix}/ folder");
      return { requirements: [], epics: [], projectName: "untitled-project", featurePrefix: "untitled" };
    }

    const content = await readFile(specPath, "utf-8");
    const spec = JSON.parse(content);

    // Extract project/feature name and prefix
    const projectName = String(
      spec.featureName || spec.projectName || spec.name || "untitled-project"
    );
    const resolvedFeaturePrefix = String(
      spec.featurePrefix || featurePrefix || "untitled"
    );

    if (!spec.requirements || !Array.isArray(spec.requirements)) {
      return { requirements: [], epics: [], projectName, featurePrefix: resolvedFeaturePrefix };
    }

    const requirements = spec.requirements.map(
      (req: Record<string, unknown>, index: number): Requirement => {
        const base: Requirement = {
          id: String(req.id || "") || generateFallbackId("req", index),
          title: String(req.title || ""),
          description: String(req.description || ""),
          priority: parsePriority(req.priority),
          status: "pending",
          acceptanceCriteria: Array.isArray(req.acceptanceCriteria)
            ? req.acceptanceCriteria.map(String)
            : [],
        };

        // Preserve optional fields if present in spec
        if (req.epicId) {
          base.epicId = String(req.epicId);
        }
        if (req.area) {
          base.area = String(req.area);
        }
        if (req.platform && ["frontend", "backend", "both"].includes(String(req.platform))) {
          base.platform = String(req.platform) as "frontend" | "backend" | "both";
        }
        if (Array.isArray(req.dependencies)) {
          base.dependencies = req.dependencies.map(String);
        }
        if (Array.isArray(req.files)) {
          base.files = req.files.map(String);
        }
        if (Array.isArray(req.smokeTestRefs)) {
          base.smokeTestRefs = req.smokeTestRefs.map(String);
        }

        return base;
      }
    );

    // Parse epics and link requirements to them
    // Build a map from original spec index to parsed requirement ID for linking
    const specRequirements = spec.requirements as Array<Record<string, unknown>>;
    const epics: Epic[] = (spec.epics || []).map(
      (epic: Record<string, unknown>, epicIndex: number): Epic => {
        const epicId = String(epic.id || "") || generateFallbackId("epic", epicIndex);

        // Find requirements that belong to this epic and get their parsed IDs
        const linkedRequirementIds = specRequirements
          .map((r, idx) => ({ epicId: r.epicId, parsedId: requirements[idx].id }))
          .filter((r) => r.epicId === epic.id)
          .map((r) => r.parsedId);

        return {
          id: epicId,
          title: String(epic.title || ""),
          goal: String(epic.goal || ""),
          priority: parsePriority(epic.priority),
          definitionOfDone: String(epic.definitionOfDone || ""),
          keyScreens: Array.isArray(epic.keyScreens)
            ? epic.keyScreens.map(String)
            : [],
          smokeTestIds: Array.isArray(epic.smokeTestIds)
            ? epic.smokeTestIds.map(String)
            : [],
          requirementIds: linkedRequirementIds,
          status: "pending",
          progress: {
            total: linkedRequirementIds.length,
            completed: 0,
            failed: 0,
            inProgress: 0,
          },
        };
      }
    );

    // Validate uniqueness of IDs
    validateUniqueIds(requirements, "requirement");
    validateUniqueIds(epics, "epic");

    return { requirements, epics, projectName, featurePrefix: resolvedFeaturePrefix };
  } catch (error) {
    console.error("Error parsing requirements:", error);
    return { requirements: [], epics: [], projectName: "untitled-project", featurePrefix: "untitled" };
  }
}
