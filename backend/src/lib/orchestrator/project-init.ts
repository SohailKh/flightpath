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
 * Initialize the target project directory and copy feature spec
 */
export async function initializeTargetProject(targetPath: string): Promise<void> {
  const { mkdir, copyFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  // Create target directory structure
  const claudeDir = join(targetPath, ".claude", "pipeline");
  await mkdir(claudeDir, { recursive: true });

  // Initialize git repository so agent commits go to the right place
  await execAsync("git init", { cwd: targetPath });
  console.log(`[Orchestrator] Initialized git repository at ${targetPath}`);

  // Copy feature spec from flightpath to target project
  const sourceSpec = join(FLIGHTPATH_ROOT, ".claude", "pipeline", "feature-spec.v3.json");
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
}

/**
 * Parse requirements, epics, and project name from the feature spec file
 */
export async function parseRequirementsFromSpec(): Promise<ParsedFeatureSpec> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");

    const specPath = join(
      FLIGHTPATH_ROOT,
      ".claude",
      "pipeline",
      "feature-spec.v3.json"
    );

    if (!existsSync(specPath)) {
      console.warn("Feature spec not found:", specPath);
      return { requirements: [], epics: [], projectName: "untitled-project" };
    }

    const content = await readFile(specPath, "utf-8");
    const spec = JSON.parse(content);

    // Extract project/feature name
    const projectName = String(
      spec.featureName || spec.projectName || spec.name || "untitled-project"
    );

    if (!spec.requirements || !Array.isArray(spec.requirements)) {
      return { requirements: [], epics: [], projectName };
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

    return { requirements, epics, projectName };
  } catch (error) {
    console.error("Error parsing requirements:", error);
    return { requirements: [], epics: [], projectName: "untitled-project" };
  }
}
