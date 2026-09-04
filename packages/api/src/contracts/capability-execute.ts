/**
 * ONE input contract for "run a registered capability".
 *
 * `executeCapability` (services/capabilities/execute-capability.ts) is a single
 * shared core reached through four doors — tRPC `capabilities.execute`, Hub REST
 * `POST /capabilities/execute`, the MCP tool `synap_run_capability`, and the
 * Intelligence Service's own `run_capability`. Each of those had, until this
 * file existed, its own independently hand-written notion of what a caller may
 * SAY, in three different declaration languages (a zod `.input()`, a
 * `@hono/zod-openapi` request schema, and a hand-written JSON Schema literal).
 *
 * The measured cost of that: the tRPC door — the BROWSER door, the one a human
 * clicks — declared four of the service's twelve parameters. It could not pass
 * `sessionId`, so every browser-launched capability run landed with
 * `proposals.session_id = NULL`; the live pod's session-provenance rate is 2.6%
 * and this door is the reason. It could not pass `channelId`/`sourceMessageId`,
 * so the origin-trust classification at rung 2.55 could never activate on a
 * browser run. It could not pass `idempotencyKey`, so a retry had no caller
 * correlation.
 *
 * ── WHAT THIS SCHEMA IS, PRECISELY ──────────────────────────────────────────
 * The CLIENT-SUPPLIABLE half of the service's parameter list. Three parameters
 * are deliberately absent, and their absence is a rule rather than an omission:
 *
 *   • `userId` — the acting operator. Derived from the transport's authenticated
 *     identity at every door (tRPC `ctx.userId`, Hub `resolveActingContext`, MCP
 *     `ctx.userId`). A body field would let a caller name someone else.
 *   • `agentUserId` — the acting agent. Derived from the API key (Hub
 *     `c.get("agentUserId")`, MCP's agent-key remap). A body field would let an
 *     agent launder itself into an operator, or an operator impersonate an
 *     agent — the exact bypass `checkPermissionOrPropose` exists to prevent.
 *   • `suppressProposal` — INTERNAL ONLY. It converts a `propose` verdict into a
 *     plain `deny` and exists for callers with no interactive review surface
 *     (the automation executor). A client that could set it could suppress its
 *     own governance receipt.
 *
 * That split is not documentation: it is what `CLIENT_SUPPLIED_PARAMS` below
 * asserts, and what the input-parity tripwire
 * (`__tripwires__/cross-door-input-parity.test.ts`, T5) holds every door to.
 *
 * ── ZOD 4, AND THE DOOR THAT CANNOT HAVE IT ─────────────────────────────────
 * This is zod 4.3.6. tRPC, Hub REST and MCP all import it directly. The
 * Intelligence Service is pinned to zod 3 and cannot, so it consumes the
 * COMMITTED JSON Schema artifact emitted from this same schema
 * (`generated/capability-execute.schema.json`), kept honest by
 * `capability-execute-schema-freshness.test.ts`. One contract, two
 * serializations, no second hand-written shape.
 */

import { z } from "zod";

/** Runtime 1-of-N connection selector — which of a capability's connections runs. */
export const ConnectionSelectorSchema = z.object({
  /** A specific connection id. */
  connectionId: z.string().optional(),
  /** The connection bound to this context object. */
  contextObjectId: z.string().optional(),
});

/**
 * The client-suppliable input to a capability run.
 *
 * Every field is optional here so a door can tighten it (tRPC requires
 * `verbId` + `workspaceId` for back-compat with the browser client). A door may
 * narrow this contract; a door may not widen past it, and may not silently drop
 * a field from it — T5 fails on the drop.
 */
export const CapabilityExecuteInput = z.object({
  /** The capability verb to run — the backing skill's NAME. One of verbId/skillId required. */
  verbId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The capability verb to run — the backing skill's NAME (e.g. 'gmail_send'). One of verbId/skillId is required."
    ),
  /** Direct backing-skill id (alternative to verbId). */
  skillId: z
    .string()
    .min(1)
    .optional()
    .describe("Direct backing-skill id (alternative to verbId)."),
  /** Inputs passed to the skill sandbox (`args`). */
  parameters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "The capability's own inputs, passed to the skill sandbox as `args` — e.g. { to, subject, body } for gmail_send."
    ),
  /**
   * Acting workspace — an OPTIONAL lens narrowing the skill lookup and the gate.
   * Omit for a pod-wide run; a `propose` then routes to the pod-wide queue.
   */
  workspaceId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Acting workspace — an optional lens narrowing the skill lookup and the gate. Omit for a pod-wide run."
    ),
  connectionSelector: ConnectionSelectorSchema.optional().describe(
    "Which of the capability's connections this run uses, when it has more than one. A selector matching nothing fails the run."
  ),
  /**
   * Caller idempotency key correlating retries of THIS logical run. Stamped onto
   * a `capability.run` proposal AND used as the direct-run receipt CAS claim, so
   * an external-send verb is at-most-once. Omitted → a content hash is derived,
   * which collides an identical retry but cannot tell two deliberate identical
   * runs apart.
   */
  idempotencyKey: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A stable key correlating retries of THIS logical run, so an external-send verb is at-most-once. Omitted → a content hash is derived."
    ),
  /**
   * Instruction-provenance (rung 2.55): the acting channel of this agent turn.
   * A run triggered from an untrusted-origin channel (external / bridge) force-
   * proposes instead of auto-running. Tighten-only and server-classified — an
   * absent or owner channel never downgrades anything.
   */
  channelId: z
    .string()
    .optional()
    .describe(
      "Instruction-provenance: the acting channel of this agent turn. A run triggered from an untrusted-origin channel force-proposes instead of auto-running."
    ),
  /**
   * The triggering inbound message id. Resolved server-side to the acting
   * `channelId` when one is not passed explicitly.
   */
  sourceMessageId: z
    .string()
    .optional()
    .describe(
      "The triggering inbound message id, resolved server-side to the acting channel when channelId is not passed explicitly."
    ),
  /**
   * The focus session this run belongs to. Persisted as the
   * `proposals.session_id` COLUMN so a reviewer sees which operation an action
   * was part of. Absent → null; non-session activity is legitimate.
   */
  sessionId: z
    .string()
    .optional()
    .describe(
      "The focus session this run belongs to. Persisted as the proposals.session_id column so a reviewer sees which operation the action was part of."
    ),
});

export type CapabilityExecuteInput = z.infer<typeof CapabilityExecuteInput>;

/**
 * The parameters of `executeCapability` a CLIENT may supply.
 *
 * Kept as data (not just as the schema's key list) because the tripwire and the
 * schema-emit both need to name it, and because the three EXCLUDED parameters
 * need somewhere their exclusion is stated as a fact rather than inferred from
 * an absence.
 */
export const CLIENT_SUPPLIED_PARAMS = Object.keys(
  CapabilityExecuteInput.shape
) as Array<keyof typeof CapabilityExecuteInput.shape>;

/**
 * Parameters that are NEVER a client field, with the reason. Read the header:
 * the first two are identity (a body field would be an impersonation door) and
 * the third is a governance suppressor.
 */
export const SERVER_DERIVED_PARAMS = [
  "userId",
  "agentUserId",
  "suppressProposal",
] as const;

/**
 * What the MCP tool `synap_run_capability` publishes.
 *
 * A subset, and the subset is the point: `sessionId`, `sourceMessageId` and
 * `channelId` are AMBIENT on an MCP turn (the X-Session-Id header and the
 * calling agent's own channel), so the handler supplies them from context. A
 * model-supplied `sessionId` would let an agent file its run under someone
 * else's operation.
 */
export const MCP_AGENT_PARAMS = [
  "verbId",
  "skillId",
  "parameters",
  "workspaceId",
  "connectionSelector",
  "idempotencyKey",
] as const;

export const CapabilityExecuteAgentInput = CapabilityExecuteInput.pick(
  Object.fromEntries(MCP_AGENT_PARAMS.map((k) => [k, true])) as Record<
    (typeof MCP_AGENT_PARAMS)[number],
    true
  >
);
