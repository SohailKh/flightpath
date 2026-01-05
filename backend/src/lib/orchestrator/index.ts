/**
 * Pipeline Orchestrator
 *
 * Manages the full workflow: QA → (Explore → Plan → Execute → Test) loop
 * Handles agent chaining, retry logic, and abort/pause controls.
 */

// Public API
export { runQAPhase, handleUserMessage } from "./qa-phase";
export { resumePipeline, runImplementationLoop } from "./loop";

// Re-export types that may be needed externally
export { type TestVerdict } from "./test-phase";
