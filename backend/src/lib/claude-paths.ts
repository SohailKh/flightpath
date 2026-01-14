/**
 * Central path resolution for .claude storage directories.
 * All pipeline-related files (state, artifacts, logs, smoke tests) are stored
 * in backend/.claude/{claudeStorageId}/ to keep target projects clean.
 */

import { resolve, join } from "node:path";

export const BACKEND_ROOT = resolve(import.meta.dirname, "..", "..");
export const CLAUDE_STORAGE_ROOT = join(BACKEND_ROOT, ".claude");
const CLAUDE_DIR_NAME = ".claude";

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

export function getClaudeStorageRoot(claudeStorageId?: string): string | null {
  if (!claudeStorageId) return null;
  return join(CLAUDE_STORAGE_ROOT, claudeStorageId);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function rewriteClaudeFilePath(
  value: string,
  claudeStorageId?: string
): string {
  if (!value) return value;
  const storageRoot = getClaudeStorageRoot(claudeStorageId);
  if (!storageRoot) return value;

  const normalizedValue = normalizePath(value);
  const normalizedStorageRoot = normalizePath(storageRoot);
  const normalizedStorageBase = normalizePath(CLAUDE_STORAGE_ROOT);

  if (
    normalizedValue === normalizedStorageRoot ||
    normalizedValue.startsWith(`${normalizedStorageRoot}/`) ||
    normalizedValue.startsWith(`${normalizedStorageBase}/`)
  ) {
    return value;
  }

  const parts = normalizedValue.split("/");
  const claudeIndex = parts.indexOf(CLAUDE_DIR_NAME);
  if (claudeIndex === -1) return value;

  const suffix = parts.slice(claudeIndex + 1).join("/");
  return suffix ? `${normalizedStorageRoot}/${suffix}` : normalizedStorageRoot;
}

export function rewriteClaudeCommand(
  command: string,
  claudeStorageId?: string
): string {
  if (!command) return command;
  const storageRoot = getClaudeStorageRoot(claudeStorageId);
  if (!storageRoot) return command;

  const normalizedRoot = normalizePath(storageRoot);
  let rewritten = command;

  rewritten = rewritten.replace(
    /\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)\/\.claude\//g,
    `${normalizedRoot}/`
  );
  rewritten = rewritten.replace(
    /`git\s+rev-parse\s+--show-toplevel`\s*\/\.claude\//g,
    `${normalizedRoot}/`
  );
  rewritten = rewritten.replace(
    /\$\{?PWD\}?\/\.claude\//g,
    `${normalizedRoot}/`
  );
  rewritten = rewritten.replace(
    /(^|[\s"'`=([{;|&:])(?:\.\.\/)+\.claude\//g,
    (_match, prefix) => `${prefix}${normalizedRoot}/`
  );
  rewritten = rewritten.replace(
    /(^|[\s"'`=([{;|&:])(?:\.\/)?\.claude\//g,
    (_match, prefix) => `${prefix}${normalizedRoot}/`
  );

  return rewritten;
}
