import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { BACKEND_ROOT } from "../claude-paths";
import { getPipeline, type Requirement } from "../pipeline";

const REQUIREMENTS_DIR = join(BACKEND_ROOT, ".flightpath", "data");

export interface RequirementsSnapshot {
  pipelineId: string;
  updatedAt: string;
  requirements: Requirement[];
}

class AsyncLock {
  private pending = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn, fn);
    this.pending = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

const locks = new Map<string, AsyncLock>();

function getLock(pipelineId: string): AsyncLock {
  const existing = locks.get(pipelineId);
  if (existing) return existing;
  const lock = new AsyncLock();
  locks.set(pipelineId, lock);
  return lock;
}

export function getRequirementsSnapshotPath(pipelineId: string): string {
  return join(REQUIREMENTS_DIR, `requirements-${pipelineId}.json`);
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(REQUIREMENTS_DIR, { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, contents, "utf-8");
  await rename(tempPath, path);
}

export async function writeRequirementsSnapshot(pipelineId: string): Promise<void> {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return;

  const snapshot: RequirementsSnapshot = {
    pipelineId,
    updatedAt: new Date().toISOString(),
    requirements: pipeline.requirements,
  };

  const path = getRequirementsSnapshotPath(pipelineId);
  await getLock(pipelineId).run(() =>
    writeFileAtomic(path, JSON.stringify(snapshot, null, 2))
  );
}

export async function readRequirementsSnapshot(
  pipelineId: string
): Promise<RequirementsSnapshot | null> {
  const path = getRequirementsSnapshotPath(pipelineId);
  if (!existsSync(path)) return null;
  const contents = await readFile(path, "utf-8");
  return JSON.parse(contents) as RequirementsSnapshot;
}
