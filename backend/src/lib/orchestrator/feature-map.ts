/**
 * Feature map helpers for multi-feature QA decomposition.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sanitizeProjectName, FLIGHTPATH_ROOT } from "./project-init";
import { CLAUDE_STORAGE_ROOT } from "../claude-paths";

export type FeatureSize = "small" | "medium" | "large" | "xlarge";
export type DecompositionMode = "all" | "selected";

export interface FeatureMapFeature {
  id: string;
  name: string;
  prefix: string;
  summary: string;
  priority: number;
  size?: FeatureSize;
  estimatedRequirements?: number;
  dependencies: string[];
  notes: string[];
}

export interface FeatureMap {
  schemaVersion: number;
  projectName: string;
  projectSummary: string;
  targetPlatforms: string[];
  generatedAt: string;
  decompositionMode: DecompositionMode;
  selectedFeatureIds: string[];
  features: FeatureMapFeature[];
}

const FEATURE_MAP_FILE = "feature-map.json";

export function getFeatureMapPath(
  rootPath: string = FLIGHTPATH_ROOT,
  claudeStorageId?: string
): string {
  if (claudeStorageId) {
    return join(CLAUDE_STORAGE_ROOT, claudeStorageId, FEATURE_MAP_FILE);
  }
  return join(resolve(rootPath), ".claude", FEATURE_MAP_FILE);
}

export function getFeatureSpecPath(
  featurePrefix: string,
  rootPath: string = FLIGHTPATH_ROOT,
  claudeStorageId?: string
): string {
  if (claudeStorageId) {
    return join(CLAUDE_STORAGE_ROOT, claudeStorageId, featurePrefix, "feature-spec.v3.json");
  }
  return join(resolve(rootPath), ".claude", featurePrefix, "feature-spec.v3.json");
}

export function getSmokeTestsPath(
  featurePrefix: string,
  rootPath: string = FLIGHTPATH_ROOT,
  claudeStorageId?: string
): string {
  if (claudeStorageId) {
    return join(CLAUDE_STORAGE_ROOT, claudeStorageId, featurePrefix, "smoke-tests.json");
  }
  return join(resolve(rootPath), ".claude", featurePrefix, "smoke-tests.json");
}

function normalizePrefix(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) {
    return sanitizeProjectName(raw);
  }
  return sanitizeProjectName(fallback) || "feature";
}

function coerceNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

export async function loadFeatureMap(
  rootPath: string = FLIGHTPATH_ROOT,
  claudeStorageId?: string
): Promise<FeatureMap | null> {
  const featureMapPath = getFeatureMapPath(rootPath, claudeStorageId);
  if (!existsSync(featureMapPath)) return null;

  try {
    const raw = await readFile(featureMapPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const rawFeatures = Array.isArray(parsed.features) ? parsed.features : [];
    const features = rawFeatures.map((rawFeature, index) => {
      const feature = rawFeature as Record<string, unknown>;
      const id = String(feature.id || `feature-${index + 1}`);
      const name = String(feature.name || feature.title || id);
      const prefix = normalizePrefix(feature.prefix, name || id);
      const summary = String(feature.summary || "");
      const priority = coerceNumber(feature.priority, index + 1);
      const size = typeof feature.size === "string" ? (feature.size as FeatureSize) : undefined;
      const estimatedRequirements =
        typeof feature.estimatedRequirements === "number"
          ? feature.estimatedRequirements
          : undefined;
      const dependencies = coerceStringArray(feature.dependencies);
      const notes = coerceStringArray(feature.notes);

      return {
        id,
        name,
        prefix,
        summary,
        priority,
        size,
        estimatedRequirements,
        dependencies,
        notes,
      } satisfies FeatureMapFeature;
    });

    const decompositionMode =
      parsed.decompositionMode === "selected" ? "selected" : "all";
    const selectedFeatureIds = coerceStringArray(parsed.selectedFeatureIds);

    return {
      schemaVersion: coerceNumber(parsed.schemaVersion, 1),
      projectName: String(parsed.projectName || "untitled-project"),
      projectSummary: String(parsed.projectSummary || ""),
      targetPlatforms: coerceStringArray(parsed.targetPlatforms),
      generatedAt: String(parsed.generatedAt || new Date().toISOString()),
      decompositionMode,
      selectedFeatureIds,
      features,
    };
  } catch (error) {
    console.warn("[feature-map] Failed to parse feature map:", error);
    return null;
  }
}

export function resolveSelectedFeatures(featureMap: FeatureMap): FeatureMapFeature[] {
  if (featureMap.decompositionMode === "selected" && featureMap.selectedFeatureIds.length > 0) {
    const selected = new Set(featureMap.selectedFeatureIds);
    return featureMap.features.filter((feature) => selected.has(feature.id));
  }
  return [...featureMap.features];
}

export function sortFeaturesByPriority(
  features: FeatureMapFeature[]
): FeatureMapFeature[] {
  return [...features].sort((a, b) => {
    const aPriority = Number.isFinite(a.priority) ? a.priority : Number.MAX_SAFE_INTEGER;
    const bPriority = Number.isFinite(b.priority) ? b.priority : Number.MAX_SAFE_INTEGER;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.id.localeCompare(b.id);
  });
}

export function getPendingFeatures(
  featureMap: FeatureMap,
  rootPath: string = FLIGHTPATH_ROOT,
  claudeStorageId?: string
): FeatureMapFeature[] {
  const selected = resolveSelectedFeatures(featureMap);
  return sortFeaturesByPriority(selected).filter((feature) => {
    const specPath = getFeatureSpecPath(feature.prefix, rootPath, claudeStorageId);
    return !existsSync(specPath);
  });
}

export function selectPrimaryFeature(
  featureMap: FeatureMap
): FeatureMapFeature | null {
  const selected = resolveSelectedFeatures(featureMap);
  if (selected.length === 0) return null;
  return sortFeaturesByPriority(selected)[0];
}
