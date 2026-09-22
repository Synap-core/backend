/**
 * Proposal Wire Codec — Hub Protocol REST schemas for proposals.
 *
 * Proposals are the core governance primitive: AI/connector mutations create
 * a pending proposal that humans review. Approval emits the underlying side
 * effect via the event chain.
 */

import { z } from "@hono/zod-openapi";
import {
  PROPOSAL_CLASSES,
  proposalClassFields,
} from "../../../../services/proposals/proposal-class.js";
import { projectProposalRowForViewer } from "../../../proposals/failure-projection.js";

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

/**
 * Decision CLASS of a proposal — WHAT KIND of decision it is, and therefore how
 * long it stays answerable. Derived on read from `proposalType` × `targetType`
 * (never stored, never agent-nominated); see `services/proposals/proposal-class.ts`
 * for why that derivation is a security property.
 */
export const ProposalClassSchema = z
  .enum(PROPOSAL_CLASSES)
  .openapi("ProposalClass");

/**
 * The two class fields every proposal projection carries. Declared once and
 * spread into both `WireProposalSchema` and `ProposalBasicSchema` so the two
 * views cannot describe the class differently.
 */
const proposalClassShape = {
  class: ProposalClassSchema.describe(
    "Decision class — derived from proposalType x targetType, not stored."
  ),
  lifetimeHours: z
    .number()
    .nullable()
    .describe(
      "Hours this proposal stays answerable once its context is gone. " +
        "`null` for every class that never expires; only `ephemeral` has one."
    ),
} as const;

/**
 * SETUP — what a `capability.install` proposal still needs from a human before
 * it can be applied, DERIVED on read from the capability's manifest plus live
 * vault/Nango state (`services/proposals/proposal-setup.ts`). Never stored, so
 * adding the missing key clears the gap without touching the proposal.
 *
 * `.optional()` and it must stay optional: an ABSENT `setup` means "this
 * proposal has no manifest to derive one from" (any non-install proposal, or an
 * install whose template this pod never cached) — which is a different fact
 * from `{blocking:false}`, "we looked and nothing is needed". Defaulting one to
 * the other is how a surface starts rendering "ready to install" over a package
 * it knows nothing about.
 *
 * A param's VALUE is structurally absent: the schema carries `name`, `label`,
 * `secret`, `satisfied` and a `vault://` REF, and no value field exists to put
 * a credential in.
 */
const ProposalSetupParamSchema = z
  .object({
    name: z.string(),
    label: z.string().optional(),
    type: z.string().optional(),
    required: z.boolean(),
    description: z.string().optional(),
    secret: z
      .boolean()
      .describe("Prompt masked. The VALUE is never on the wire."),
    satisfied: z
      .boolean()
      .describe(
        "A non-blank value is present, or a resolvable `vault://` ref is."
      ),
    ref: z
      .string()
      .optional()
      .describe("`vault://<id>` when this param points at a vault secret."),
    // LABELS for that ref — a name and a category, never a value. Without them
    // every surface renders a linked secret as the generic "Linked vault
    // secret", so approving an install whose credential an AGENT chose was
    // blind consent. Resolved under the same own-or-pod-wide predicate as
    // `satisfied`, so a label can never disclose a secret the caller cannot see.
    refName: z
      .string()
      .optional()
      .describe("The linked secret's vault NAME. A label, never a value."),
    refService: z
      .string()
      .optional()
      .describe("The linked secret's category, e.g. `Stripe`. Never a value."),
    refUnresolved: z
      .boolean()
      .optional()
      .describe(
        "The ref does not resolve for this caller (deleted, or not theirs). " +
          "Distinct from 'not filled in yet' — the surface must say so."
      ),
  })
  .openapi("ProposalSetupParam");

export const ProposalSetupSchema = z
  .object({
    params: z.array(ProposalSetupParamSchema),
    connection: z
      .object({
        required: z.boolean(),
        kind: z.string().nullable(),
        provider: z.string().optional(),
        state: z.string(),
      })
      .passthrough()
      .optional()
      .describe(
        "PROVIDER (OAuth) connection only — a vault-kind requirement is already " +
          "expressed by the params that feed it, and surfacing it twice makes a " +
          "filled form still read 'needs a connection'."
      ),
    blocking: z
      .boolean()
      .describe(
        "Any REQUIRED param unsatisfied, or a REQUIRED provider connection not `connected`."
      ),
    nextAction: z
      .object({
        kind: z.string(),
        hint: z.string(),
        url: z.string().optional(),
        opensIn: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .openapi("ProposalSetup");

const proposalSetupShape = {
  setup: ProposalSetupSchema.optional(),
} as const;

/**
 * Stamp the class fields onto a raw proposal row. THE producer behind
 * `WireProposalSchema`'s `class` — a declared field with no producer is the
 * exact shape of the T4 finding ("a DECLARED zod schema IS the contract"), so
 * every door that answers with `WireProposalSchema` passes its rows through
 * here.
 */
export function withProposalClass<T extends Record<string, unknown>>(
  row: T
): T & { class: string; lifetimeHours: number | null } {
  return {
    // AGENT-ONLY FAILURE FIELDS are stripped HERE, at the producer every
    // `view=full` door passes its rows through — `data.failure.detail` is the
    // redacted raw executor error, written for the AI explanation path, and
    // this projection is a client answer. See `failure-projection.ts`.
    ...projectProposalRowForViewer(row),
    ...proposalClassFields(
      String(row.proposalType ?? ""),
      String(row.targetType ?? "")
    ),
  };
}

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
    ...proposalClassShape,
    ...proposalSetupShape,
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
    materializedIds: z
      .record(
        z.string(),
        z.object({
          op: z.string(),
          id: z.string(),
          linked: z.literal(true).optional(),
          revertedAt: z.string().optional(),
        })
      )
      .optional()
      .describe(
        "Applied composites / plans only: op ref → the real id that op produced " +
          "(`linked` = an existing row it reused; `revertedAt` = undone since). " +
          "Absent until the proposal applies — refs never map to guessed ids."
      ),
    summary: z
      .string()
      .optional()
      .describe(
        `Author-written one-liner, capped at ${PROPOSAL_SUMMARY_MAX} chars. ` +
          "Omitted entirely when the proposal carries none — never generated."
      ),
    ...proposalClassShape,
    // On the BASIC row too, and for the same reason `class` is: "this one needs
    // an API key before it can be approved" is a TRIAGE fact. A caller that can
    // only learn it after fetching the full payload cannot triage a queue — and
    // the MCP list is exactly the door that cannot afford the full payload.
    ...proposalSetupShape,
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
/** Upper bound on `materializedIds` entries on a BASIC row — a list stays bounded. */
export const PROPOSAL_MATERIALIZED_IDS_MAX = 200;

const BY_OP_ID_KEYS = [
  "entityId",
  "sessionId",
  "projectId",
  "documentId",
  "relationId",
  "linkId",
  "skillId",
  "automationId",
  "ruleId",
] as const;

/**
 * ref → the REAL id each op of an applied composite produced, lifted from the
 * record the materializer stamps (`data.materialized.byOp`). This is how an
 * agent that filed a plan by REF reads the ids once it applies: before
 * approval there is no record, so the key is absent — never a guessed id.
 * Bounded by {@link PROPOSAL_MATERIALIZED_IDS_MAX}.
 */
function materializedIdsOf(
  data: Record<string, unknown>
): ProposalBasic["materializedIds"] | undefined {
  const byOp = (data.materialized as { byOp?: unknown } | undefined)?.byOp;
  if (!byOp || typeof byOp !== "object") return undefined;
  const out: NonNullable<ProposalBasic["materializedIds"]> = {};
  let count = 0;
  for (const [ref, entry] of Object.entries(byOp as Record<string, unknown>)) {
    if (count >= PROPOSAL_MATERIALIZED_IDS_MAX) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const idKey = BY_OP_ID_KEYS.find((k) => typeof e[k] === "string");
    if (!idKey || typeof e.op !== "string") continue;
    out[ref] = {
      op: e.op,
      id: e[idKey] as string,
      ...(e.linked === true || e.preExisting === true ? { linked: true } : {}),
      ...(typeof e.revertedAt === "string" ? { revertedAt: e.revertedAt } : {}),
    };
    count++;
  }
  return count > 0 ? out : undefined;
}

export function toProposalBasic(row: Record<string, unknown>): ProposalBasic {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const quality = (data.quality ?? {}) as Record<string, unknown>;
  const raw = quality.summary ?? data.summary;
  const summary =
    typeof raw === "string" && raw.length > 0
      ? raw.slice(0, PROPOSAL_SUMMARY_MAX)
      : undefined;
  const materializedIds = materializedIdsOf(data);
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
    ...(materializedIds ? { materializedIds } : {}),
    // Class + lifetime travel with the BASIC row: the ephemeral countdown is a
    // list-row affordance ("this expires in 6h"), and a caller that can only
    // see it after fetching the full payload cannot triage a queue.
    ...proposalClassFields(
      row.proposalType as string,
      row.targetType as string
    ),
    // FORWARDED, not derived. `setup` needs the template cache, the vault and
    // Nango — this projection is pure and cannot reach any of them. Its
    // PRODUCER is `resolveProposalSetups`, stamped by the list procedure that
    // feeds this door (`hub-protocol/proposals.ts`). A declared field with no
    // producer is the T4 defect; a declared field whose producer sits upstream
    // is fine, provided the door actually forwards it — which is what the
    // `proposal-setup-reaches-read-doors` tripwire drives end to end.
    ...(row.setup ? { setup: row.setup as ProposalBasic["setup"] } : {}),
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
