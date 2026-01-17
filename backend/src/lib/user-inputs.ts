/**
 * User Inputs Storage Module
 *
 * Handles storage of user-provided inputs during pipeline execution:
 * - Secrets (API keys, etc.) → stored in .env file
 * - Files (audio, images, etc.) → stored in artifacts/user-inputs/
 *
 * Storage location: backend/.claude/{claudeStorageId}/
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { CLAUDE_STORAGE_ROOT, getClaudeProjectPath } from "./claude-paths";
import type { UserInputFileRef } from "./agent";

/**
 * Get the .env file path for a pipeline
 */
export function getEnvFilePath(claudeStorageId: string): string {
  return join(getClaudeProjectPath(claudeStorageId), ".env");
}

/**
 * Get the user-inputs artifacts directory for a pipeline
 */
export function getUserInputsPath(claudeStorageId: string): string {
  return join(getClaudeProjectPath(claudeStorageId), "artifacts", "user-inputs");
}

/**
 * Ensure the user-inputs directory exists
 */
function ensureUserInputsDir(claudeStorageId: string): void {
  const dir = getUserInputsPath(claudeStorageId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Ensure the .claude directory exists for a storage ID
 */
function ensureClaudeDir(claudeStorageId: string): void {
  const dir = getClaudeProjectPath(claudeStorageId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Store a secret value to the .env file
 * Appends if the variable doesn't exist, updates if it does
 */
export function storeSecretToEnv(
  claudeStorageId: string,
  envVarName: string,
  value: string
): void {
  ensureClaudeDir(claudeStorageId);
  const envPath = getEnvFilePath(claudeStorageId);

  // Sanitize the env var name (only allow alphanumeric and underscores)
  const sanitizedName = envVarName.replace(/[^A-Z0-9_]/gi, "_").toUpperCase();

  // Read existing .env file if it exists
  let envContent = "";
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, "utf-8");
  }

  // Check if the variable already exists
  const lines = envContent.split("\n");
  const existingIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith(`${sanitizedName}=`) ||
      trimmed.startsWith(`${sanitizedName} =`)
    );
  });

  // Escape the value for .env format (wrap in quotes if contains special chars)
  const needsQuotes = /[\s"'`$\\]/.test(value) || value.includes("#");
  const escapedValue = needsQuotes
    ? `"${value.replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`
    : value;

  const newLine = `${sanitizedName}=${escapedValue}`;

  if (existingIndex !== -1) {
    // Update existing line
    lines[existingIndex] = newLine;
    writeFileSync(envPath, lines.join("\n"), "utf-8");
  } else {
    // Append new line
    const separator = envContent.endsWith("\n") || envContent === "" ? "" : "\n";
    appendFileSync(envPath, `${separator}${newLine}\n`, "utf-8");
  }

  console.log(`[UserInputs] Stored secret ${sanitizedName} in ${envPath}`);
}

/**
 * Store an uploaded file to the artifacts/user-inputs directory
 * Returns a reference to the stored file
 */
export function storeUploadedFile(
  claudeStorageId: string,
  filename: string,
  data: Buffer | Uint8Array,
  mimeType: string
): UserInputFileRef {
  ensureUserInputsDir(claudeStorageId);

  // Sanitize the filename to prevent path traversal
  const sanitizedFilename = filename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".");

  // Generate a unique artifact ID
  const artifactId = `user-input-${Date.now()}-${sanitizedFilename}`;
  const storagePath = join(getUserInputsPath(claudeStorageId), sanitizedFilename);

  // Write the file
  writeFileSync(storagePath, data);

  console.log(`[UserInputs] Stored file ${sanitizedFilename} (${data.length} bytes) at ${storagePath}`);

  return {
    artifactId,
    filename: sanitizedFilename,
    mimeType,
    sizeBytes: data.length,
    storagePath,
  };
}

/**
 * Load all environment variables from the .env file
 * Returns a Map of variable names to values
 */
export function loadEnvFile(claudeStorageId: string): Map<string, string> {
  const envPath = getEnvFilePath(claudeStorageId);
  const envMap = new Map<string, string>();

  if (!existsSync(envPath)) {
    return envMap;
  }

  const content = readFileSync(envPath, "utf-8");
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Parse KEY=value format
    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    // Remove surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      // Unescape escaped quotes
      value = value.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\$/g, "$");
    }

    envMap.set(key, value);
  }

  return envMap;
}

/**
 * Get the path to a user-uploaded file
 */
export function getUploadedFilePath(
  claudeStorageId: string,
  filename: string
): string {
  return join(getUserInputsPath(claudeStorageId), filename);
}

/**
 * Read an uploaded file's contents
 */
export function readUploadedFile(
  claudeStorageId: string,
  filename: string
): Buffer | null {
  const filePath = getUploadedFilePath(claudeStorageId, filename);

  if (!existsSync(filePath)) {
    return null;
  }

  return readFileSync(filePath);
}

/**
 * Check if an env variable exists in the .env file
 */
export function hasEnvVar(claudeStorageId: string, envVarName: string): boolean {
  const envMap = loadEnvFile(claudeStorageId);
  return envMap.has(envVarName);
}

/**
 * Get a specific env variable value
 */
export function getEnvVar(
  claudeStorageId: string,
  envVarName: string
): string | undefined {
  const envMap = loadEnvFile(claudeStorageId);
  return envMap.get(envVarName);
}

/**
 * List all uploaded files for a pipeline
 */
export function listUploadedFiles(claudeStorageId: string): string[] {
  const dir = getUserInputsPath(claudeStorageId);

  if (!existsSync(dir)) {
    return [];
  }

  const { readdirSync } = require("node:fs");
  return readdirSync(dir) as string[];
}

/**
 * Delete an uploaded file
 */
export function deleteUploadedFile(
  claudeStorageId: string,
  filename: string
): boolean {
  const filePath = getUploadedFilePath(claudeStorageId, filename);

  if (!existsSync(filePath)) {
    return false;
  }

  const { unlinkSync } = require("node:fs");
  unlinkSync(filePath);
  console.log(`[UserInputs] Deleted file ${filename} from ${filePath}`);
  return true;
}

/**
 * Remove an env variable from the .env file
 */
export function removeEnvVar(claudeStorageId: string, envVarName: string): boolean {
  const envPath = getEnvFilePath(claudeStorageId);

  if (!existsSync(envPath)) {
    return false;
  }

  const content = readFileSync(envPath, "utf-8");
  const lines = content.split("\n");
  const sanitizedName = envVarName.replace(/[^A-Z0-9_]/gi, "_").toUpperCase();

  const filteredLines = lines.filter((line) => {
    const trimmed = line.trim();
    return !(
      trimmed.startsWith(`${sanitizedName}=`) ||
      trimmed.startsWith(`${sanitizedName} =`)
    );
  });

  if (filteredLines.length === lines.length) {
    return false; // Variable not found
  }

  writeFileSync(envPath, filteredLines.join("\n"), "utf-8");
  console.log(`[UserInputs] Removed env var ${sanitizedName} from ${envPath}`);
  return true;
}
