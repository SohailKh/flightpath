/**
 * Artifact storage for pipeline outputs.
 * Saves screenshots, test results, and diffs to local filesystem.
 */

import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Get the artifacts base directory path for a given feature prefix
 */
function getArtifactsBasePath(featurePrefix: string): string {
  return `.claude/${featurePrefix}/artifacts`;
}

export type ArtifactType = "screenshot" | "test_result" | "diff";

export interface SavedArtifact {
  id: string;
  type: ArtifactType;
  path: string;
  size: number;
  createdAt: string;
}

/**
 * Get the artifacts directory
 * Uses targetProjectPath if provided, otherwise falls back to process.cwd()
 * featurePrefix defaults to "pipeline" for backward compatibility
 */
function getArtifactsDir(targetProjectPath?: string, featurePrefix: string = "pipeline"): string {
  const baseDir = targetProjectPath || process.cwd();
  return join(baseDir, getArtifactsBasePath(featurePrefix));
}

/**
 * Ensure the artifacts directory exists
 */
async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Generate a unique artifact ID
 */
function generateArtifactId(type: ArtifactType, index: number): string {
  const timestamp = Date.now();
  return `${type}-${String(index).padStart(3, "0")}-${timestamp}`;
}

/**
 * Get the file extension for an artifact type
 */
function getExtension(type: ArtifactType): string {
  switch (type) {
    case "screenshot":
      return ".png";
    case "test_result":
      return ".json";
    case "diff":
      return ".patch";
    default:
      return ".bin";
  }
}

/**
 * Count existing artifacts of a given type
 */
async function countArtifacts(
  type: ArtifactType,
  targetProjectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<number> {
  const dir = getArtifactsDir(targetProjectPath, featurePrefix);
  if (!existsSync(dir)) return 0;

  const files = await readdir(dir);
  return files.filter((f) => f.startsWith(type)).length;
}

/**
 * Save an artifact to the filesystem
 */
export async function saveArtifact(
  type: ArtifactType,
  data: Buffer | string,
  requirementId?: string,
  targetProjectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<SavedArtifact> {
  const dir = getArtifactsDir(targetProjectPath, featurePrefix);
  await ensureDir(dir);

  const count = await countArtifacts(type, targetProjectPath, featurePrefix);
  const id = generateArtifactId(type, count + 1);
  const ext = getExtension(type);
  const filename = `${id}${ext}`;
  const path = join(dir, filename);

  // Convert string to buffer if needed
  const buffer = typeof data === "string" ? Buffer.from(data, "utf-8") : data;

  await writeFile(path, buffer);

  // Get file stats for size
  const stats = await stat(path);

  return {
    id,
    type,
    path: join(getArtifactsBasePath(featurePrefix), filename),
    size: stats.size,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Save a screenshot (convenience wrapper)
 */
export async function saveScreenshot(
  imageData: Buffer,
  requirementId?: string,
  targetProjectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<SavedArtifact> {
  return saveArtifact(
    "screenshot",
    imageData,
    requirementId,
    targetProjectPath,
    featurePrefix
  );
}

/**
 * Save a test result (convenience wrapper)
 */
export async function saveTestResult(
  result: Record<string, unknown>,
  requirementId?: string,
  targetProjectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<SavedArtifact> {
  const jsonData = JSON.stringify(result, null, 2);
  return saveArtifact(
    "test_result",
    jsonData,
    requirementId,
    targetProjectPath,
    featurePrefix
  );
}

/**
 * Save a diff (convenience wrapper)
 */
export async function saveDiff(
  diffContent: string,
  requirementId?: string,
  targetProjectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<SavedArtifact> {
  return saveArtifact(
    "diff",
    diffContent,
    requirementId,
    targetProjectPath,
    featurePrefix
  );
}

/**
 * Get an artifact by ID
 */
export async function getArtifact(
  artifactId: string,
  targetProjectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<Buffer | null> {
  const dir = getArtifactsDir(targetProjectPath, featurePrefix);
  if (!existsSync(dir)) return null;

  const files = await readdir(dir);
  const file = files.find((f) => f.startsWith(artifactId));
  if (!file) return null;

  const path = join(dir, file);
  return readFile(path);
}

/**
 * List all artifacts
 */
export async function listArtifacts(
  targetProjectPath?: string,
  featurePrefix: string = "pipeline"
): Promise<SavedArtifact[]> {
  const dir = getArtifactsDir(targetProjectPath, featurePrefix);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const artifacts: SavedArtifact[] = [];

  for (const file of files) {
    const path = join(dir, file);
    const stats = await stat(path);

    // Parse artifact ID and type from filename
    const match = file.match(/^(screenshot|test_result|diff)-(\d+)-(\d+)/);
    if (match) {
      const [, type, , timestamp] = match;
      artifacts.push({
        id: file.replace(/\.[^.]+$/, ""), // Remove extension
        type: type as ArtifactType,
        path: join(getArtifactsBasePath(featurePrefix), file),
        size: stats.size,
        createdAt: new Date(parseInt(timestamp, 10)).toISOString(),
      });
    }
  }

  return artifacts.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

/**
 * Get artifact content type for HTTP response
 */
export function getContentType(artifactId: string): string {
  if (artifactId.startsWith("screenshot")) {
    return "image/png";
  } else if (artifactId.startsWith("test_result")) {
    return "application/json";
  } else if (artifactId.startsWith("diff")) {
    return "text/plain";
  }
  return "application/octet-stream";
}
