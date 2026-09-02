/**
 * Proposal Wire Codec — Hub Protocol REST schemas for proposals.
 *
 * Proposals are the core governance primitive: AI/connector mutations create
 * a pending proposal that humans review. Approval emits the underlying side
 * effect via the event chain.
 */

import { z } from "@hono/zod-openapi";

/**
 * The selectable `status` filters for a proposal listing — the SSOT every
 * surface over the proposals queue reuses (the OpenAPI query schema below, the
 * tRPC `listProposals` input enum, the REST `GET /proposals` handler's 400
 * guard, and the `synap_list_proposals` MCP tool schema) so those four can't
 * drift apart.
 *
 * Covers EVERY value the `proposals.status` column can hold, plus "all".
 * `auto_approved` is the load-bearing entry: an auto-approved agent write
 * executes immediately and files a proposal row purely as an audit receipt
 * ("executed immediately, audited here for traceability" —
 * `database/schema/proposals.ts`). While this list held only three states those
 * receipts existed but no surface could list them.
 *
 * Lives in this codec module because it is a zod-only leaf — the tRPC router
 * and the REST handler both import it without pulling each other in.
 *
 * `PROPOSAL_ROW_STATUSES` below is the same list minus `"all"`: every value the
 * `proposals.status` COLUMN can hold, without the pseudo-value that only makes
 * sense as a filter.
 *
 * The row list is declared here independently of the Drizzle `ProposalStatus` const rather than
 * derived from it, on purpose: the `declared-enum-covers-column` tripwire
 * asserts this list is a superset of the DB enum, and a derived list would make
 * that assertion tautological. Drift between the wire contract and the column
 * is exactly the bug that tripwire exists to catch.
 */
export const PROPOSAL_ROW_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "auto_approved",
  "reverted",
  "approval_failed",
  "withdrawn",
  // Never decided — its moment passed. See ProposalStatus.EXPIRED.
  "expired",
] as const;

export const PROPOSAL_STATUS_FILTERS = [
  ...PROPOSAL_ROW_STATUSES,
  "all",
] as const;

export type ProposalStatusFilter = (typeof PROPOSAL_STATUS_FILTERS)[number];

/** Canonical proposal status FILTER values (row states + `all`). */
export const ProposalStatusSchema = z
  .enum(PROPOSAL_STATUS_FILTERS)
  .openapi("ProposalStatus");

/**
 * Canonical proposal ROW status — what a serialized proposal's `status` field
 * can actually be. Distinct from `ProposalStatusSchema`, which additionally
 * carries the `"all"` filter sentinel that no row ever holds.
 */
export const ProposalRowStatusSchema = z
  .enum(PROPOSAL_ROW_STATUSES)
  .openapi("ProposalRowStatus");

/** Wire shape of a proposal row. */
export const WireProposalSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string().nullable(),
    targetType: z.string(),
    targetId: z.string(),
    proposalType: z.string(),
    data: z.record(z.string(), z.unknown()),
    // Was a hand-typed 3-value enum while the column held 7 — so the published
    // OpenAPI told every generated client that `auto_approved` (the audit
    // receipt of an executed agent write) could never appear on a row.
    status: ProposalRowStatusSchema,
    agentUserId: z.string().nullable().optional(),
    threadId: z.string().nullable().optional(),
    sourceMessageId: z.string().nullable().optional(),
    createdBy: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
    sessionId: z.string().nullable().optional(),
  })
  .openapi("Proposal");

// ── LIST vs GET projection ────────────────────────────────────────────────
//
// GitHub calls these the "summary representation" (returned by list endpoints)
// and the "detailed representation" (returned by a single-resource fetch);
// Google AIP-157 formalises the same split as a `view` enum on the request
// rather than two hand-rolled serializers. Two AIP-157 rules bind here:
//
//   1. The DEFAULT must be the FULL response — "having a partial response be
//      the default can degrade the effectiveness of declarative clients", and
//      the generated Hub client is exactly such a client. So `view=full` is the
//      default and reproduces today's payload byte-for-byte.
//   2. "APIs must never remove fields from an existing view" — a view is a
//      permanent ratchet, so BASIC starts as NARROW as it can usefully be.
//      Widening later is legal; narrowing is not.
//
// Without this split there was no door that distinguished the two, and both
// consumers invented their own: the CLI hand-rolled a truncation, and the MCP
// list returned 283,737 characters for 33 rows — past the tool-result ceiling,
// so the caller got an error instead of a list.

export const PROPOSAL_VIEWS = ["full", "basic"] as const;
export type ProposalView = (typeof PROPOSAL_VIEWS)[number];

/**
 * Server-side cap on the projected `summary`.
 *
 * 280 chars: a summary is a one-line "what does this proposal do" for a list
 * row, and 280 is enough for a full sentence while bounding a page of 50 rows
 * at ~14KB of summary text — two orders of magnitude below the payload that
 * broke the MCP tool-result ceiling. The uncapped field is still available at
 * `view=full` inside `data`, so nothing is lost, only bounded.
 */
export const PROPOSAL_SUMMARY_MAX = 280;

/**
 * BASIC projection — identity + provenance scalars only. `data` is
 * deliberately ABSENT: it is an unbounded JSONB blob and it is the entire
 * reason the full projection cannot be listed.
 */
export const ProposalBasicSchema = z
  .object({
    id: z.string(),
    proposalType: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    status: ProposalRowStatusSchema,
    workspaceId: z.string().nullable(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    correlationId: z.string().nullable(),
    sessionId: z.string().nullable(),
    agentUserId: z.string().nullable(),
    summary: z
      .string()
      .optional()
      .describe(
        `Author-written one-liner, capped at ${PROPOSAL_SUMMARY_MAX} chars. ` +
          "Omitted entirely when the proposal carries none — never generated."
      ),
  })
  .openapi("ProposalBasic");

export type ProposalBasic = z.infer<typeof ProposalBasicSchema>;

/**
 * THE definition of BASIC. Both the REST `view=basic` path and the MCP
 * `detail:"summary"` path call this — that single-definition property is the
 * point of the slice, not an incidental refactor.
 *
 * The summary is only ever LIFTED from data the server already holds
 * (`data.quality.summary` / `data.summary`). Absent ⇒ the field is omitted; we
 * never emit an empty string and never fabricate a sentence.
 */
export function toProposalBasic(row: Record<string, unknown>): ProposalBasic {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const quality = (data.quality ?? {}) as Record<string, unknown>;
  const raw = quality.summary ?? data.summary;
  const summary =
    typeof raw === "string" && raw.length > 0
      ? raw.slice(0, PROPOSAL_SUMMARY_MAX)
      : undefined;
  return {
    id: row.id as string,
    proposalType: row.proposalType as string,
    targetType: row.targetType as string,
    targetId: row.targetId as string,
    status: row.status as ProposalBasic["status"],
    workspaceId: (row.workspaceId ?? null) as string | null,
    createdAt: row.createdAt as ProposalBasic["createdAt"],
    correlationId: (row.correlationId ?? null) as string | null,
    sessionId: (row.sessionId ?? null) as string | null,
    agentUserId: (row.agentUserId ?? null) as string | null,
    ...(summary ? { summary } : {}),
  };
}

/** GET /proposals query. */
export const ListProposalsQuerySchema = z
  .object({
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    status: ProposalStatusSchema.optional().describe(
      "Defaults to `pending`. Use `all` to return every status. " +
        "`auto_approved` returns the audit receipts of agent writes that were " +
        "executed immediately under governance rather than queued for review."
    ),
    view: z
      .enum(PROPOSAL_VIEWS)
      .optional()
      .describe(
        "`full` (DEFAULT) returns the complete proposal row including the " +
          "unbounded `data` payload. `basic` returns identity + provenance " +
          "scalars and a capped `summary`, with NO `data` — use it to " +
          "enumerate a queue without paying for every payload."
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Page size. Defaults to 50, clamped to 200."),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Rows to skip (native SQL OFFSET). Defaults to 0. The response carries " +
          "`total` and `hasMore`, so a caller never has to infer the size of " +
          "the queue from the size of the page."
      ),
  })
  .openapi("ListProposalsQuery");

/** PATCH /proposals/{id} request body. */
export const UpdateProposalRequestSchema = z
  .object({
    data: z
      .record(z.string(), z.unknown())
      .describe("Updated proposal payload (replaces existing data)."),
    summary: z
      .string()
      .optional()
      .describe("Human-readable summary of the revision."),
  })
  .openapi("UpdateProposalRequest");

/** POST /proposals request body. */
export const CreateProposalRequestSchema = z
  .object({
    workspaceId: z.string().nullable().optional(),
    agentUserId: z.string().optional(),
    channelId: z
      .string()
      .optional()
      .describe("Channel/thread originating the proposal."),
    targetType: z
      .string()
      .describe("Subject type the proposal mutates (e.g. entity, view)."),
    targetId: z
      .string()
      .describe(
        "ID of the target subject (existing record or stable temp id)."
      ),
    proposalType: z
      .string()
      .describe("Sub-action, e.g. entity.create, view.update, vault.request."),
    data: z
      .record(z.string(), z.unknown())
      .describe("Free-form proposal payload — shape is targetType-specific."),
    summary: z.string().optional(),
    sessionId: z
      .string()
      .optional()
      .describe("Focus session ID to link this proposal to."),
    sourceMessageId: z
      .string()
      .optional()
      .describe(
        "Message that originated the proposal — for event chain causality."
      ),
  })
  .openapi("CreateProposalRequest");

/** POST /proposals minimal response. */
export const CreateProposalResponseSchema = z
  .object({
    id: z.string(),
    status: z.literal("pending"),
  })
  .openapi("CreateProposalResponse");
