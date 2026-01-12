/**
 * Pipeline Orchestrator
 *
 * Manages the QA phase for requirement gathering.
 * Implementation is handled by the harness module (see lib/harness/).
 */

// Public API
export { runQAPhase, handleUserMessage } from "./qa-phase";

// Re-export harness for convenience
export { runHarness } from "../harness";
