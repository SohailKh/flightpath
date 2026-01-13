/**
 * Central path resolution for .claude storage directories.
 * All pipeline-related files (state, artifacts, logs, smoke tests) are stored
 * in backend/.claude/{claudeStorageId}/ to keep target projects clean.
 */

import { resolve, join } from "node:path";

export const BACKEND_ROOT = resolve(import.meta.dirname, "..", "..");
export const CLAUDE_STORAGE_ROOT = join(BACKEND_ROOT, ".claude");

/**
 * Generate a unique storage ID for a pipeline
 * Format: {sanitizedProjectName}-{pipelineIdShort}
 * Example: "my-todo-app-abc12345"
 */
export function generateClaudeStorageId(
  sanitizedProjectName: string,
  pipelineId: string
): string {
  const shortId = pipelineId.slice(0, 8);
  return `${sanitizedProjectName}-${shortId}`;
}

/**
 * Get the base .claude directory for a pipeline
 */
export function getClaudeProjectPath(claudeStorageId: string): string {
  return join(CLAUDE_STORAGE_ROOT, claudeStorageId);
}

/**
 * Get the feature-specific directory within a pipeline's .claude storage
 */
export function getClaudeFeaturePath(
  claudeStorageId: string,
  featurePrefix: string = "pipeline"
): string {
  return join(CLAUDE_STORAGE_ROOT, claudeStorageId, featurePrefix);
}

/**
 * Get the artifacts directory for a pipeline
 */
export function getArtifactsPath(
  claudeStorageId: string,
  featurePrefix: string = "pipeline"
): string {
  return join(getClaudeFeaturePath(claudeStorageId, featurePrefix), "artifacts");
}
