/**
 * Artifact storage for pipeline outputs.
 * Saves screenshots, test results, and diffs to local filesystem.
 */

import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const ARTIFACTS_BASE_DIR = ".claude/artifacts";

export type ArtifactType = "screenshot" | "test_result" | "diff";

export interface SavedArtifact {
  id: string;
  type: ArtifactType;
  path: string;
  size: number;
  createdAt: string;
}

/**
 * Get the artifacts directory for a pipeline
 */
function getArtifactsDir(pipelineId: string): string {
  return join(process.cwd(), ARTIFACTS_BASE_DIR, pipelineId);
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
  pipelineId: string,
  type: ArtifactType
): Promise<number> {
  const dir = getArtifactsDir(pipelineId);
  if (!existsSync(dir)) return 0;

  const files = await readdir(dir);
  return files.filter((f) => f.startsWith(type)).length;
}

/**
 * Save an artifact to the filesystem
 */
export async function saveArtifact(
  pipelineId: string,
  type: ArtifactType,
  data: Buffer | string,
  requirementId?: string
): Promise<SavedArtifact> {
  const dir = getArtifactsDir(pipelineId);
  await ensureDir(dir);

  const count = await countArtifacts(pipelineId, type);
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
    path: join(ARTIFACTS_BASE_DIR, pipelineId, filename),
    size: stats.size,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Save a screenshot (convenience wrapper)
 */
export async function saveScreenshot(
  pipelineId: string,
  imageData: Buffer,
  requirementId?: string
): Promise<SavedArtifact> {
  return saveArtifact(pipelineId, "screenshot", imageData, requirementId);
}

/**
 * Save a test result (convenience wrapper)
 */
export async function saveTestResult(
  pipelineId: string,
  result: Record<string, unknown>,
  requirementId?: string
): Promise<SavedArtifact> {
  const jsonData = JSON.stringify(result, null, 2);
  return saveArtifact(pipelineId, "test_result", jsonData, requirementId);
}

/**
 * Save a diff (convenience wrapper)
 */
export async function saveDiff(
  pipelineId: string,
  diffContent: string,
  requirementId?: string
): Promise<SavedArtifact> {
  return saveArtifact(pipelineId, "diff", diffContent, requirementId);
}

/**
 * Get an artifact by ID
 */
export async function getArtifact(
  pipelineId: string,
  artifactId: string
): Promise<Buffer | null> {
  const dir = getArtifactsDir(pipelineId);
  if (!existsSync(dir)) return null;

  const files = await readdir(dir);
  const file = files.find((f) => f.startsWith(artifactId));
  if (!file) return null;

  const path = join(dir, file);
  return readFile(path);
}

/**
 * List all artifacts for a pipeline
 */
export async function listArtifacts(
  pipelineId: string
): Promise<SavedArtifact[]> {
  const dir = getArtifactsDir(pipelineId);
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
        path: join(ARTIFACTS_BASE_DIR, pipelineId, file),
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
