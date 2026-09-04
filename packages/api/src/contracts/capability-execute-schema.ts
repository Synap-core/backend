/**
 * The capability-execute input contract, as JSON Schema.
 *
 * Pure and dependency-light on purpose: BOTH the generator that writes the
 * committed artifact and the freshness test that checks it call this one
 * function, so "what should be in the file" has exactly one definition. A
 * generator that builds the shape inline and a test that rebuilds it its own way
 * are two projections of one contract — the defect this whole contract exists to
 * remove.
 *
 * `$schema` is stripped: MCP `inputSchema` entries are plain sub-schemas, and a
 * committed artifact needs a deterministic diff.
 */
import { z } from "zod";

import {
  CapabilityExecuteAgentInput,
  CapabilityExecuteInput,
} from "./capability-execute.js";

/** The FULL client-suppliable contract — what Hub REST and tRPC accept. */
export function buildCapabilityExecuteJsonSchema(): Record<string, unknown> {
  const derived = z.toJSONSchema(CapabilityExecuteInput, {
    io: "input",
  }) as Record<string, unknown>;
  delete derived.$schema;
  return derived;
}

/**
 * The AGENT subset — what the MCP tool `synap_run_capability` publishes.
 *
 * Prose descriptions are layered on top, exactly as
 * `routers/mcp/tools/index.ts` already does for the automation data contract
 * and the rule sentence: the zod shape cannot carry "call
 * synap_list_capabilities first", and prose is not what drifts.
 */
export function buildCapabilityExecuteAgentJsonSchema(): Record<
  string,
  unknown
> {
  const derived = z.toJSONSchema(CapabilityExecuteAgentInput, {
    io: "input",
  }) as Record<string, unknown>;
  delete derived.$schema;

  const properties = derived.properties as Record<
    string,
    Record<string, unknown>
  >;
  properties.verbId.description =
    "The capability name from synap_list_capabilities (e.g. 'gmail_send'). Alternatively pass skillId.";
  properties.skillId.description =
    "Direct backing-skill UUID (alternative to verbId).";
  properties.parameters.description =
    "The capability's inputs — e.g. { to, subject, body } for gmail_send, { query } for gmail_search.";
  properties.workspaceId.description = "Workspace UUID";
  properties.connectionSelector.description =
    "Which of the capability's connections this run uses, when it has more than one. `connectionId` names a specific connection; `contextObjectId` names the connection bound to that context object. Omit to use the only/default connection — a selector matching nothing fails the run.";
  properties.idempotencyKey.description =
    "Optional: a stable key that correlates retries of THIS run. Note: a direct capability run has NO automatic content dedup — a retried call CAN produce a second external effect (e.g. a second send). Pass a key when the effect must be at-most-once; the key is recorded on the run.";

  // The tool has always required a workspace, and the manifest (and every
  // generated client built from it) says so. The contract keeps `workspaceId`
  // optional because the Hub door genuinely allows a pod-wide run; this door
  // does not. Narrowing is allowed, silently dropping is not.
  derived.required = ["workspaceId"];
  return derived;
}
