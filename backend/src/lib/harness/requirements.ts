import { getPipeline } from "../pipeline";

/**
 * Check if all requirements are processed (completed or failed)
 */
export function areAllRequirementsProcessed(pipelineId: string): boolean {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) return true;

  return pipeline.requirements.every(
    (req) => req.status === "completed" || req.status === "failed"
  );
}

/**
 * Get summary of requirement statuses
 */
export function getRequirementsSummary(pipelineId: string): {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  inProgress: number;
} {
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) {
    return { total: 0, completed: 0, failed: 0, pending: 0, inProgress: 0 };
  }

  const requirements = pipeline.requirements;
  return {
    total: requirements.length,
    completed: requirements.filter((r) => r.status === "completed").length,
    failed: requirements.filter((r) => r.status === "failed").length,
    pending: requirements.filter((r) => r.status === "pending").length,
    inProgress: requirements.filter((r) => r.status === "in_progress").length,
  };
}
