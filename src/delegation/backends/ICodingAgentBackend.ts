/**
 * ICodingAgentBackend — adapter interface every coding-agent backend
 * implements (docs/phase-c2-coding-agent-delegation.md §8.1).
 *
 * The concrete types live in ../types so the service, policy, and tools can
 * share them without importing adapter modules; this module re-exports the
 * adapter-facing surface under the spec's module name.
 */

export {
  ICodingAgentBackend,
  BackendAvailability,
  BackendRunContext,
  BackendRunOutcome,
  RunningAgent,
  BackendName,
} from "../types";
