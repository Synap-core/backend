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

import { CapabilityExecuteInput } from "./capability-execute.js";

/** The FULL client-suppliable contract — what Hub REST and tRPC accept. */
export function buildCapabilityExecuteJsonSchema(): Record<string, unknown> {
  const derived = z.toJSONSchema(CapabilityExecuteInput, {
    io: "input",
  }) as Record<string, unknown>;
  delete derived.$schema;
  return derived;
}
