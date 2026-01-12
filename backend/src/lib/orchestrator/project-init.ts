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

const execAsync = promisify(exec);

/**
 * Generate a fallback ID when one is not provided
 */
function generateFallbackId(prefix: string, index: number): string {
  return `${prefix}-${index + 1}`;
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

const FLIGHTPATH_PROJECTS_DIR = "flightpath-projects";

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
  return join(homedir(), FLIGHTPATH_PROJECTS_DIR, sanitized);
}

/**
 * Get the pipeline directory path for a given feature prefix
 */
export function getProjectPipelinePath(featurePrefix: string): string {
  return `.claude/${featurePrefix}`;
}

/**
 * Initialize the target project directory and copy feature spec
 */
export async function initializeTargetProject(targetPath: string, featurePrefix: string): Promise<void> {
  const { mkdir, copyFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  // Create target directory structure using feature prefix
  const claudeDir = join(targetPath, ".claude", featurePrefix);
  await mkdir(claudeDir, { recursive: true });

  // Initialize git repository so agent commits go to the right place
  await execAsync("git init", { cwd: targetPath });
  console.log(`[Orchestrator] Initialized git repository at ${targetPath}`);

  // Copy feature spec from flightpath to target project
  // Source: look in any .claude/{prefix}/ folder for feature-spec.v3.json
  const sourceSpec = join(FLIGHTPATH_ROOT, ".claude", featurePrefix, "feature-spec.v3.json");
  const targetSpec = join(claudeDir, "feature-spec.v3.json");

  if (existsSync(sourceSpec)) {
    await copyFile(sourceSpec, targetSpec);
    console.log(`[Orchestrator] Copied feature spec to ${targetSpec}`);
  } else {
    console.warn(`[Orchestrator] Feature spec not found at ${sourceSpec}`);
  }
}

export interface ParsedFeatureSpec {
  requirements: Requirement[];
  epics: Epic[];
  projectName: string;
  featurePrefix: string;
}

/**
 * Find the feature spec file in any .claude/{prefix}/ folder
 */
async function findFeatureSpecPath(): Promise<string | null> {
  const { readdir } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  const claudeDir = join(FLIGHTPATH_ROOT, ".claude");
  if (!existsSync(claudeDir)) return null;

  try {
    const entries = await readdir(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "skills") {
        const specPath = join(claudeDir, entry.name, "feature-spec.v3.json");
        if (existsSync(specPath)) {
          return specPath;
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
export async function parseRequirementsFromSpec(): Promise<ParsedFeatureSpec> {
  try {
    const { readFile } = await import("node:fs/promises");

    const specPath = await findFeatureSpecPath();

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
    const featurePrefix = String(spec.featurePrefix || "untitled");

    if (!spec.requirements || !Array.isArray(spec.requirements)) {
      return { requirements: [], epics: [], projectName, featurePrefix };
    }

    const requirements = spec.requirements.map(
      (req: Record<string, unknown>, index: number): Requirement => ({
        id: String(req.id || "") || generateFallbackId("req", index),
        title: String(req.title || ""),
        description: String(req.description || ""),
        priority: Number(req.priority || 0),
        status: "pending",
        acceptanceCriteria: Array.isArray(req.acceptanceCriteria)
          ? req.acceptanceCriteria.map(String)
          : [],
      })
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
          priority: Number(epic.priority || 0),
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

    return { requirements, epics, projectName, featurePrefix };
  } catch (error) {
    console.error("Error parsing requirements:", error);
    return { requirements: [], epics: [], projectName: "untitled-project", featurePrefix: "untitled" };
  }
}
