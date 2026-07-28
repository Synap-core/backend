/**
 * Universal Proposal Types
 *
 * Defines the contract for all data mutations in the system.
 */

import type { EventAction } from "../events/unified.js";
import { isLikelyUUID } from "./proposal-utils.js";
export { isLikelyUUID };

// Re-export database types for proposals
export type { Proposal, NewProposal } from "@synap/database";

// NOTE: Zod schemas (insertProposalSchema, selectProposalSchema)
// intentionally NOT re-exported — they pull in postgres/drizzle which breaks
// browser/Electron builds. Backend consumers should import directly from
// @synap/database.

/**
 * Proposal status as stored in the DB.
 * Includes "auto_approved" for whitelist-bypassed actions.
 */
export type ProposalStatusString =
  "pending" | "approved" | "rejected" | "auto_approved";

/**
 * Status filter accepted by `proposals.list` tRPC procedure.
 * Uses "validated" as the public alias for "approved" (DB value).
 * Use this type anywhere a status filter is accepted by the API.
 */
export type ProposalStatusFilter = "pending" | "validated" | "rejected" | "all";

/**
 * Structured whole-proposal rejection reason taxonomy — Phase 1 of the
 * reasoned-rejection loop (`PROPOSAL-GRANULAR-REASONED-REVIEW-PLAN.md`, Fork 2A).
 *
 * PINNED CONTRACT — the enum MUST be byte-identical wherever it's consumed
 * (backend `proposals.reject`/`batchReject` input, `emitAiCorrection` data,
 * the `routing-health` `byReasonCode` breakdown, and the frontend
 * `DenyProposalModal` chips). This is the SSOT: both sides import from here
 * (`@synap-core/types` — the app's frontend package resolves it via a local
 * symlink to `synap-backend/packages/types`, so this is a true single source,
 * not a hand-synced copy).
 *
 * Each reject carries at most ONE structured code, always optional — a bare
 * reject (no code, no freeform `reason`) still works.
 */
export const PROPOSAL_REJECTION_REASONS = [
  "wrong_entity",
  "duplicate",
  "wrong_kind_or_facet",
  "wrong_link_type",
  "wrong_workspace",
  "bad_data",
  "not_relevant",
  "other",
] as const;

export type ProposalRejectionReasonCode =
  (typeof PROPOSAL_REJECTION_REASONS)[number];

/** Human-readable label per code — drives the `DenyProposalModal` chips. */
export const PROPOSAL_REJECTION_REASON_LABELS: Record<
  ProposalRejectionReasonCode,
  string
> = {
  wrong_entity: "Wrong entity",
  duplicate: "Duplicate",
  wrong_kind_or_facet: "Wrong kind/facet",
  wrong_link_type: "Wrong link type",
  wrong_workspace: "Wrong workspace",
  bad_data: "Bad data",
  not_relevant: "Not relevant",
  other: "Other",
};

/**
 * Universal Update Request
 *
 * The standard envelope for all change requests in the system.
 * This object is stored in the `proposals` table (as part of StoredProposalData)
 * and passed in events. changeType aligns with EventAction for event-sourced flow.
 */
export interface UpdateRequest {
  /** Unique ID for this specific request */
  requestId: string;

  /** Who initiated the change? */
  source:
    | "user"
    | "ai"
    | "system"
    | "intelligence"
    | "agent"
    | "openwebui-pipeline"
    | "extension"
    | "cli"
    | "n8n"
    | "raycast";
  sourceId: string;

  /** Context */
  workspaceId: string | null;

  /** Target Entity */
  targetType: "document" | "entity" | "whiteboard" | "view" | "profile";
  targetId: string;
  /** Human-readable target label resolved server-side when available. */
  targetName?: string;

  /** What kind of change? (aligns with EventAction) */
  changeType: EventAction;

  /**
   * Lightweight metadata changes (e.g. title rename, status change).
   * For entities: create/update payload. For documents: not used when proposedContent is used.
   */
  data?: Record<string, unknown>;

  /**
   * Heavy Content Reference (S3/MinIO).
   * Used for Documents, Whiteboards, etc.
   */
  contentRef?: {
    storageKey: string;
    mimeType: string;
    size: number;
    checksum?: string;
  };

  /** AI Reasoning / Context */
  reasoning?: string;
  /** Short human-readable summary resolved server-side when available. */
  summary?: string;

  /**
   * Event-chain linkage.
   *
   * `correlationId` groups the requested/validated/completed events for this
   * proposal. `requestedEventId` points at the concrete `.requested` event when
   * the write path created one before pausing for review.
   */
  correlationId?: string;
  requestedEventId?: string;
  validatedEventId?: string;
  completedEventId?: string;
}

export interface ProposalReviewChange {
  path: string;
  label: string;
  operation: "create" | "update" | "delete" | "set";
  before?: unknown;
  after?: unknown;
  valueType?: string;
}

export interface ProposalReviewEvent {
  eventId: string;
  eventType: string;
  phase?: string;
  action?: string;
  subjectType: string;
  subjectId: string;
  timestamp: string;
  userId: string;
  source?: string;
  correlationId?: string;
}

/**
 * Reviewable, frontend-facing summary of a COMPOSITE (graph) proposal.
 *
 * A composite proposal's `data` is `{ operations: [...] }`, which the flat
 * `ProposalReviewChange[]` cannot express. This carries the graph so the review
 * UI can render the entities and relations that approval would materialize.
 *
 * PINNED CONTRACT — the frontend mirrors this shape exactly; do not change field
 * names/shapes without updating the frontend in lockstep.
 */
export interface ProposalReviewGraph {
  entities: Array<{
    ref: string;
    profileSlug: string;
    title: string;
    propertyCount: number;
    hasContent: boolean;
    /**
     * Roles (facets) this KIND wears — the facet model made legible on the
     * entity itself. Includes the entity's EXISTING roles (`isNew:false`,
     * resolved from live `entity_facets` for ops that reference a pre-existing
     * entity) and the roles this proposal ATTACHES (`isNew:true`, from the op's
     * inline `facets`). A new role is emphasized in the UI ("Grimkujow becomes a
     * Lead"). Mirrors the frontend `@synap-core/proposal-types` shape exactly.
     */
    roles?: Array<{ profileSlug: string; isNew: boolean; status?: string }>;
  }>;
  relations: Array<{
    type: string;
    sourceLabel: string;
    targetLabel: string;
    /** Ref into `entities[]` when the source endpoint is part of this graph. */
    sourceRef?: string;
    /** Ref into `entities[]` when the target endpoint is part of this graph. */
    targetRef?: string;
    /**
     * Stable per-item address for this relation within the proposal — the
     * positional `$relN` ordinal (N = index among create_relation ops, in
     * operations order). The per-item review UI keys a relation's disposition
     * (accept/edit/reject) by this ref, exactly as an entity's disposition is
     * keyed by its `entities[].ref` ($opN / op `ref`). Minted in
     * `buildProposalGraph`; `approve` recomputes the same ordinal to map a
     * `$relN` disposition back to the Nth create_relation op. Mirrors the
     * frontend `@synap-core/proposal-types` shape exactly.
     */
    itemRef?: string;
  }>;
  entityCount: number;
  relationCount: number;
  /** Count of newly-attached roles (`isNew`) across all entities. */
  facetCount: number;
}

export interface ProposalReviewModel {
  summary: string;
  actorName?: string;
  targetName?: string;
  reasoning?: string;
  source?: UpdateRequest["source"];
  sourceId?: string;
  sourceMessageId?: string | null;
  threadId?: string | null;
  commandRunId?: string | null;
  correlationId?: string;
  requestedEventId?: string;
  validatedEventId?: string;
  completedEventId?: string;
  changes: ProposalReviewChange[];
  /**
   * Present ONLY for composite (graph) proposals. When set, `changes` may be
   * empty and the graph carries the reviewable content.
   */
  graph?: ProposalReviewGraph;
  events: ProposalReviewEvent[];
}

/**
 * Request-shaped proposal data (event-sourced path).
 * Written by global-validator and entity proposals from chat.
 * Approve uses this to emit `*.validated`.
 */
export interface RequestShapedProposalData
  extends UpdateRequest, ProposalDataLifecycle {
  reasoning?: string;
  aiMetadata?: Record<string, unknown>;
  /**
   * Before-snapshot captured at proposal-creation time for UPDATE proposals.
   * Mirrors the top-level fields of `data` (title, description, profileSlug,
   * documentId) plus a `properties` map, holding the entity's state BEFORE the
   * proposed change. The review layer prefers this over a live entity lookup so
   * the before→after diff is durable — it survives approval/materialization and
   * any concurrent edit to the live entity. Absent for create/delete/composite.
   */
  previousData?: {
    title?: string | null;
    description?: string | null;
    profileSlug?: string | null;
    documentId?: string | null;
    properties?: Record<string, unknown>;
  };
}

/**
 * Document-content proposal data (direct content path).
 * Written by hub document edit, infinite-chat document edit, user_edit.
 * Approve uses proposedContent and applies to storage/versions.
 */
export interface DocumentContentProposalData extends ProposalDataLifecycle {
  proposedContent: string;
  proposedBy?: string;
  changes?: unknown[];
  originalContent?: string | null;
  expiresAt?: string;
  range?: [number, number];
  originalSnippet?: string;
  replacementText?: string;
  messageId?: string;
  threadId?: string;
}

/**
 * Composite (multi-op) proposal data — a GRAPH proposal.
 *
 * A SINGLE approvable proposal that, on approval, executes N operations
 * atomically. It expresses a small GRAPH: one or more new entities plus the
 * relations among them, validated by the user as ONE unit of work.
 *
 * References between operations use REFS, not pre-minted entity ids — entities
 * have no id until approval (see the deliberate "no draft entity" invariant).
 * A relation's `sourceRef`/`targetRef` is one of:
 *   - an op ref: the `ref` of a `create_entity` op in THIS proposal (e.g. "t1"),
 *   - the positional ref `$opN` (N = index of the create_entity op),
 *   - `PRIMARY_REF` ("$primary") — the FIRST create_entity op (back-compat),
 *   - a real, already-existing entity UUID (link new graph to existing data).
 * At approval, all entity ops are created first, building a ref→realId map; then
 * relations are created resolving each ref through that map (falling back to the
 * literal value, treated as a real entity id).
 *
 * Back-compat: the original shape (op[0] = primary create_entity, rest =
 * create_relation using $primary) is a strict subset and keeps working.
 *
 * Rides in proposals.data — no schema migration. Narrow with
 * isCompositeProposalData() in the approve flow BEFORE the single-op branches.
 */
export const PRIMARY_REF = "$primary" as const;

/** Positional ref for the Nth create_entity op (0-based), e.g. "$op0". */
export function opRef(index: number): string {
  return `$op${index}`;
}

export interface CompositeCreateEntityOp {
  op: "create_entity";
  /** Profile slug for the new entity (e.g. "question"). */
  profileSlug: string;
  /** Existing project to file the created entity into at materialization. */
  projectId?: string;
  /**
   * Pin this entity to a specific workspace at materialization (multi-home
   * import graphs). When set, materializeCompositeGraph passes it through to
   * entities.create as `targetWorkspaceId` and forces `workspaceScoped: true`.
   * Ops without it keep the caller's ambient workspaceScoped flag (proposal
   * approve path unchanged). entities.create validates membership.
   */
  targetWorkspaceId?: string;
  title?: string;
  description?: string;
  properties?: Record<string, unknown>;
  /**
   * Long-form body. When set, the entity-create path materializes a LINKED
   * DOCUMENT (versioned, MinIO-stored) instead of inlining into properties.
   * Used by markdown/document import.
   */
  content?: string;
  /**
   * Link to an EXISTING entity instead of creating one. When set, the writer
   * registers this op's ref → existingEntityId (so relations can target it) and
   * skips creation. Lets a graph mix new and pre-existing entities (capture's
   * "link don't create" path).
   */
  existingEntityId?: string;
  /**
   * Stable handle for THIS entity within the proposal, used by relation ops to
   * reference it (e.g. "t1"). Optional — the positional `$opN` ref always works.
   */
  ref?: string;
  /**
   * Role-profile facets (Kind + Facets) to attach to this entity once it
   * materializes. Additive — ops without `facets` behave exactly as before.
   * `contextRef` disambiguates repeated-role attaches and resolves through the
   * same ref→realId map as relation ops ($opN / op `ref` / $primary / a real
   * entity UUID).
   */
  facets?: Array<{
    profileSlug: string;
    status?: string;
    properties?: Record<string, unknown>;
    contextRef?: string;
  }>;
}

export interface CompositeCreateRelationOp {
  op: "create_relation";
  /** Relation type slug (system type or workspace relation_def). */
  type: string;
  /** Source: an op ref ("t1"/"$op0"/PRIMARY_REF) or a real entity UUID. */
  sourceRef: string;
  /** Target: an op ref ("t1"/"$op0"/PRIMARY_REF) or a real entity UUID. */
  targetRef: string;
  metadata?: Record<string, unknown>;
}

export type CompositeProposalOperation =
  CompositeCreateEntityOp | CompositeCreateRelationOp;

export interface CompositeProposalData extends ProposalDataLifecycle {
  /**
   * Ordered list of operations. The FIRST op MUST be a create_entity (the
   * primary entity); remaining ops are create_relation that may reference the
   * primary via PRIMARY_REF.
   */
  operations: CompositeProposalOperation[];
  /** Optional provenance carried alongside the operations. */
  source?: string;
  sourceId?: string;
  reasoning?: string;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Entity merge proposal (pod hygiene — near-duplicate → merge)
// ---------------------------------------------------------------------------

/**
 * How the detector (or a human) decided these two entities are the same
 * real-world subject. Surfaced in the review UI and audit trail.
 */
export type EntityMergeMethod =
  "strong_signal" | "exact_title" | "embedding" | "manual";

/** Property-level plan: fill empty winner fields from loser; list conflicts. */
export interface EntityMergePropertyPlan {
  /** Property keys the merge will copy from loser → winner (winner was empty). */
  filled: string[];
  /**
   * Keys where both sides have a non-empty value. W0 never silent-overwrites —
   * winner keeps its value; conflicts are listed for the reviewer.
   */
  conflicts: Array<{
    key: string;
    winnerValue: unknown;
    loserValue: unknown;
  }>;
}

/**
 * Snapshot of an entity's identity fields + properties at proposal-create /
 * pre-merge time. Captured so approve/revert can show a durable before state
 * and full unmerge can restore projection fields without a live lookup.
 */
export interface EntityMergeSnapshot {
  title?: string | null;
  preview?: string | null;
  description?: string | null;
  profileSlug?: string | null;
  documentId?: string | null;
  properties?: Record<string, unknown>;
  systemData?: Record<string, unknown>;
}

/**
 * Entity-merge proposal data — pod hygiene near-duplicate → merge.
 *
 * ALWAYS proposal-gated (`entity.merge` is in DESTRUCTIVE_ACTIONS; never in
 * DEFAULT_AUTO_APPROVE). On approve the executor (separate PR) runs
 * EntityMergeService.merge and stamps `materialized.merge` for unmerge.
 *
 * Rides in `proposals.data` — no schema migration. Narrow with
 * isEntityMergeProposalData() in the approve flow BEFORE other branches.
 */
export interface EntityMergeProposalData extends ProposalDataLifecycle {
  winnerId: string;
  loserId: string;
  confidence: number;
  method: EntityMergeMethod;
  /** Signal types/values that matched (e.g. "email:a@b.com"). */
  signalsMatched?: string[];
  reasoning?: string;
  summary?: string;
  /**
   * Entity owner userId — used by canReviewProposal (isOwner) so the data
   * owner can approve their hygiene proposals. Also the userId mergeEntities
   * runs as after admin review.
   */
  sourceId?: string;
  /** Display titles resolved at proposal-create time (review UI). */
  winnerTitle?: string;
  loserTitle?: string;
  propertyPlan?: EntityMergePropertyPlan;
  /** Winner state BEFORE merge (for review + unmerge). */
  previousWinnerSnapshot?: EntityMergeSnapshot;
  /** Loser state BEFORE soft-delete (for unmerge). */
  previousLoserSnapshot?: EntityMergeSnapshot;
}

/**
 * Record of what a proposal MATERIALIZED on approval.
 *
 * Stamped onto `proposals.data.materialized` by the approve flow so a later
 * `revert` can compute the exact inverse without a schema change. This is the
 * canonical "what did approval produce" record:
 *   - inline entity-create + composite-create mint FRESH ids (≠ proposal.targetId)
 *     so the created ids would otherwise be unrecoverable from the row alone;
 *   - relation/document ids created as a side effect are captured here too.
 * Branches whose materialized id is deterministic from the row (generic
 * `.validated` create/update where subjectId is known, document create where
 * documentId === targetId) do not strictly need this, but populate it when cheap.
 */
export interface ProposalMaterializedRecord {
  /** Entity ids CREATED by approval (revert → soft/hard delete each). */
  entityIds?: string[];
  /** Relation ids CREATED by approval (revert → delete each). */
  relationIds?: string[];
  /** Document ids CREATED by approval (revert → delete each). */
  documentIds?: string[];
  /**
   * Entity-merge materialization (pod hygiene). Stamped by the entity.merge
   * approve executor so revert can full-unmerge: reverse signals/relations/
   * links, restore facets, restore winner projection, undelete the loser.
   *
   * Full unmerge requires invertibility fields (`rewiredRelations` with prior
   * endpoints, `previousWinnerSnapshot` on proposal data). Legacy stamps that
   * only have `loserId` fall back to soft-undelete of the loser only.
   */
  merge?: {
    winnerId: string;
    loserId: string;
    movedSignalIds?: string[];
    movedExternalLinkIds?: string[];
    movedFacetIds?: string[];
    /** Facet ids created/attached on winner during merge (soft-detached on unmerge). */
    winnerFacetIds?: string[];
    /**
     * Relations re-pointed loser → winner with prior endpoints for reverse.
     * Preferred over legacy bare `rewiredRelationIds`.
     */
    rewiredRelations?: Array<{
      id: string;
      previousSourceEntityId: string | null;
      previousTargetEntityId: string | null;
    }>;
    /** @deprecated Prefer `rewiredRelations` (carries prior endpoints). */
    rewiredRelationIds?: string[];
    /** message_links rows re-pointed loser → winner. */
    rewiredMessageLinkIds?: string[];
    /** Polymorphic links re-pointed loser → winner. */
    rewiredLinkIds?: string[];
    documentMoved?: boolean;
    /**
     * Relations dropped as self-loop/dedupe during merge — irreversible;
     * recorded for audit only (cannot resurrect on unmerge).
     */
    deletedRelationIds?: string[];
  };
}

/**
 * Per-item reviewer decision on ONE graph item of a composite proposal
 * (Phase 2, per-item accept/edit/reject). Keyed in
 * `ProposalDataLifecycle.dispositions` by the item's ref — an entity's
 * `entities[].ref` ($opN / op `ref`) or a relation's `$relN` ordinal. Persisted
 * verbatim by `approve` so the partial-apply decision is durable and each
 * reasoned reject feeds the flywheel item-scoped. Rides in `proposals.data` —
 * NO migration, NO new status enum (the row stays whole-`approved`).
 */
export interface ProposalItemDisposition {
  status: "accept" | "reject" | "edit";
  reasonCode?: ProposalRejectionReasonCode;
  reason?: string;
  /** Edited entity fields for an `edit`-status entity item. */
  edits?: Record<string, unknown>;
}

/**
 * Lifecycle fields every stored-proposal variant may carry. Stamped onto the
 * `proposals.data` JSONB after approval / revert (no schema change). Shared base
 * so each variant — request-shaped, document-content, composite — accepts them
 * without tripping object-literal excess-property checks at write sites.
 */
export interface ProposalDataLifecycle {
  /** Set by approve — what this proposal produced (drives revert). */
  materialized?: ProposalMaterializedRecord;
  /**
   * Set by approve on a COMPOSITE proposal when the reviewer applied it
   * per-item (Phase 2). Keyed by item ref. Absent ⇒ the whole proposal was
   * applied (apply-all). Only the APPLIED ops appear in `materialized`.
   */
  dispositions?: Record<string, ProposalItemDisposition>;
  /** Set by revert — who/when/why the proposal's effect was undone. */
  revertedBy?: string;
  revertedAt?: string;
  revertReason?: string;
}

/**
 * Union of all shapes stored in proposals.data.
 * Use isRequestShapedProposalData() / isEntityMergeProposalData() to narrow
 * in the approve flow.
 */
export type StoredProposalData =
  | RequestShapedProposalData
  | DocumentContentProposalData
  | CompositeProposalData
  | EntityMergeProposalData;

/**
 * Type guard: true when proposal.data is request-shaped (event flow).
 * Use for the branch that emits *.validated.
 */
export function isRequestShapedProposalData(
  data: StoredProposalData | null | undefined
): data is RequestShapedProposalData {
  if (data == null || typeof data !== "object") return false;
  const d = data as unknown as Record<string, unknown>;
  return (
    typeof d.targetType === "string" &&
    typeof d.changeType === "string" &&
    typeof d.requestId === "string"
  );
}

/**
 * Type guard: true when proposal.data has proposedContent (document content flow).
 * Use for the branch that applies content directly.
 */
export function isDocumentContentProposalData(
  data: StoredProposalData | null | undefined
): data is DocumentContentProposalData {
  if (data == null || typeof data !== "object") return false;
  return (
    typeof (data as DocumentContentProposalData).proposedContent === "string"
  );
}

/**
 * Type guard: true when proposal.data is a composite (multi-op) proposal.
 * Use for the branch that executes N operations atomically on approval.
 *
 * Validates the minimal contract: a non-empty `operations` array whose first
 * op is a `create_entity`. Intentionally strict so that a malformed payload
 * falls through to the existing single-op paths rather than being mis-executed.
 */
export function isCompositeProposalData(
  data: StoredProposalData | null | undefined
): data is CompositeProposalData {
  if (data == null || typeof data !== "object") return false;
  const ops = (data as CompositeProposalData).operations;
  if (!Array.isArray(ops) || ops.length === 0) return false;
  const first = ops[0] as CompositeProposalOperation | undefined;
  if (!first || first.op !== "create_entity") return false;
  // Every op must carry a recognized discriminant.
  return ops.every(
    (o) =>
      o != null &&
      typeof o === "object" &&
      (o.op === "create_entity" || o.op === "create_relation")
  );
}

/**
 * Type guard: true when proposal.data is an entity-merge proposal
 * (winner/loser + confidence + method). Use for the branch that calls
 * EntityMergeService.merge on approval.
 *
 * Strict enough that a random payload with two entity ids won't match —
 * requires winnerId, loserId, numeric confidence, and a known method string.
 */
export function isEntityMergeProposalData(
  data: StoredProposalData | null | undefined | unknown
): data is EntityMergeProposalData {
  if (data == null || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.winnerId !== "string" || !d.winnerId) return false;
  if (typeof d.loserId !== "string" || !d.loserId) return false;
  if (typeof d.confidence !== "number" || Number.isNaN(d.confidence))
    return false;
  const method = d.method;
  return (
    method === "strong_signal" ||
    method === "exact_title" ||
    method === "embedding" ||
    method === "manual"
  );
}

// ---------------------------------------------------------------------------
// Composite (graph) approve helpers — pure ref-resolution, no DB
// ---------------------------------------------------------------------------

/**
 * Register every reference handle that should point at a just-created entity.
 *
 * Given the index of a create_entity op (in operations[]), its optional `ref`,
 * the real id it materialized to, and whether it is the FIRST entity created,
 * mutate `map` with all the handles a relation op may use to reach it:
 *   - positional `$opN` (always)
 *   - the op's own `ref` (if set)
 *   - `PRIMARY_REF` (only for the first entity, for back-compat)
 *
 * Pure and DB-free so the approve loop's resolution logic is unit-testable.
 */
export function registerEntityRef(
  map: Record<string, string>,
  opIndex: number,
  ref: string | undefined,
  realId: string,
  isFirstEntity: boolean
): void {
  map[`$op${opIndex}`] = realId;
  if (ref) map[ref] = realId;
  if (isFirstEntity) map[PRIMARY_REF] = realId;
}

/**
 * Resolve a relation op ref to a real entity id: an in-proposal ref ($opN /
 * op `ref` / $primary) maps through `map`; any other literal is treated as an
 * already-existing entity UUID and returned as-is.
 *
 * HARDENING: an unknown ref that is NOT a valid UUID is a programming/typo error
 * (e.g. a relation pointing at "$op9" that never got created). Previously such a
 * ref silently passed through as a literal entity id, producing a relation to a
 * bogus UUID-shaped string (or a malformed id) instead of failing. We now throw
 * so the mistake surfaces loudly. Real UUIDs still pass (treated as pre-existing
 * entities — the relation create validates them against the workspace).
 */
export function resolveCompositeRef(
  map: Record<string, string>,
  ref: string
): string {
  const mapped = map[ref];
  if (mapped !== undefined) return mapped;
  if (isLikelyUUID(ref)) return ref;
  throw new Error(
    `resolveCompositeRef: unknown reference "${ref}" — not an in-proposal op ref and not a valid entity UUID`
  );
}

// ---------------------------------------------------------------------------
// Enriched proposal (returned by proposals.list with pre-formed request)
// ---------------------------------------------------------------------------

/**
 * A proposal DB row enriched with a reconstructed `request` field.
 * Returned by `proposals.list` so the frontend doesn't need to reconstruct it.
 *
 * Re-exported by frontend as `UniversalProposal` for backwards compat.
 */
import type { Proposal } from "@synap/database";

export interface ProposalWithRequest extends Proposal {
  request: UpdateRequest;
}

/**
 * The nesting contract for a stored `proposals.data` envelope — the SSOT.
 *
 * Stored proposal data is an ENVELOPE `{ requestId, source, targetType,
 * changeType, data: INNER, reasoning }`. For "nested-reader" targets (entity /
 * facet / property_def / view / skill / automation / playbook / project /
 * focus_session) the executor reads the edited fields from the NESTED inner
 * (`proposal.data.data.*`). For "flat" targets (document, composite `{operations}`,
 * capability.*, provider.action, workspace/*) the fields live at the envelope top
 * level and there is no inner `data` object.
 *
 * `buildRequestFromProposal` (below) and the shared revise core
 * (`mergeProposalRevision`) both branch on this ONE predicate so a revise patch
 * always lands in the same slot the approve executors read.
 */
export function isNestedEnvelope(data: unknown): boolean {
  return (
    data != null &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).data === "object" &&
    (data as Record<string, unknown>).data !== null
  );
}

/**
 * Build an UpdateRequest from a raw proposal row's JSONB `data` column.
 * Used server-side in proposals.list and available as a shared utility.
 */
export function buildRequestFromProposal(row: Proposal): UpdateRequest {
  const raw = row.data as Record<string, unknown> | null;
  const source = normalizeProposalSource(raw?.source);
  const sourceId =
    (typeof raw?.sourceId === "string" ? raw.sourceId : "") ||
    row.agentUserId ||
    row.createdBy ||
    "";
  const changeType =
    (raw?.changeType as UpdateRequest["changeType"]) ?? "update";
  const data = isNestedEnvelope(raw)
    ? (raw!.data as UpdateRequest["data"])
    : raw && typeof raw === "object"
      ? (raw as UpdateRequest["data"])
      : undefined;

  return {
    requestId: (typeof raw?.requestId === "string" && raw.requestId) || row.id,
    source,
    sourceId,
    workspaceId: row.workspaceId,
    targetType:
      (raw?.targetType as UpdateRequest["targetType"] | undefined) ??
      (row.targetType as UpdateRequest["targetType"]),
    targetId:
      (typeof raw?.targetId === "string" && raw.targetId) || row.targetId,
    changeType,
    targetName:
      typeof raw?.targetName === "string" ? raw.targetName : undefined,
    data,
    reasoning: typeof raw?.reasoning === "string" ? raw.reasoning : undefined,
    summary:
      (typeof raw?._summary === "string" && raw._summary) ||
      (typeof raw?.summary === "string" && raw.summary) ||
      undefined,
    correlationId:
      typeof raw?.correlationId === "string" ? raw.correlationId : undefined,
    requestedEventId:
      typeof raw?.requestedEventId === "string"
        ? raw.requestedEventId
        : undefined,
    validatedEventId:
      typeof raw?.validatedEventId === "string"
        ? raw.validatedEventId
        : undefined,
    completedEventId:
      typeof raw?.completedEventId === "string"
        ? raw.completedEventId
        : undefined,
  };
}

function normalizeProposalSource(source: unknown): UpdateRequest["source"] {
  switch (source) {
    case "ai":
    case "system":
    case "intelligence":
    case "agent":
    case "openwebui-pipeline":
    case "extension":
    case "cli":
    case "n8n":
    case "raycast":
      return source;
    default:
      return "user";
  }
}

// Display utilities (pure, browser-safe)
// (isLikelyUUID is re-exported above, next to its import for resolveCompositeRef.)
export {
  resolveAuthorName,
  resolveTargetName,
  buildFallbackTitle,
} from "./proposal-utils.js";
