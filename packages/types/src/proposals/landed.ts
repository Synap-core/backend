/**
 * WHAT A PROPOSAL LANDED: the objects its approval created, updated or linked.
 *
 * ONE stamp, `data.landed` ({@link ProposalLandedRef}[]), written once by the
 * approval tail (`completeProposalApproval`, api) from what the apply recorded
 * (`data.materialized`, a run's `data.runResult`) and what the executor
 * returned (`primaryId`, a verified effect's ids). A row written before the
 * stamp, or a receipt minted before its write ran, is read from those records
 * ({@link proposalLanded}), with no migration.
 *
 * ONE answer for every surface, {@link proposalObjectsOf}: what it landed when
 * it applied, else the object the request is about (its intent).
 *
 * Pure.
 */

import { resolveProposalAction } from "./action.js";
import { isPlaybookSessionStartProposal } from "./session-start.js";
import { isLikelyUUID } from "./proposal-utils.js";
import { normalizeObjectKind } from "../vocabulary/object-kinds.js";

/** The key the stamp lives under in `proposals.data`. */
export const PROPOSAL_LANDED_KEY = "landed" as const;

export const PROPOSAL_LANDED_ROLES = ["created", "updated", "linked"] as const;
export type ProposalLandedRole = (typeof PROPOSAL_LANDED_ROLES)[number];

/**
 * The object kinds a landed ref may name: those a host opens through its
 * route table. Anything else an apply touched (a relation, a facet, a key, a
 * grant) is not an object a person goes to.
 */
export const PROPOSAL_LANDED_KINDS = [
  "entity",
  "document",
  "session",
  "project",
  "workspace",
  "automation",
  "playbook",
  "skill",
  "view",
  "cell",
  "track",
  "agent",
  "tool",
  "channel",
] as const;
export type ProposalLandedKind = (typeof PROPOSAL_LANDED_KINDS)[number];

const LANDED_KINDS: ReadonlySet<string> = new Set(PROPOSAL_LANDED_KINDS);

/** One object an approval landed, as stored. */
export interface ProposalLandedRef {
  kind: ProposalLandedKind;
  id: string;
  role: ProposalLandedRole;
}

/** The statuses whose change is in storage. */
const APPLIED_STATUSES = new Set([
  "approved",
  "auto_approved",
  "partially_approved",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && isLikelyUUID(v))
    : [];
}

/** A stored kind word (a target type, a table name) as a landed kind, or null. */
export function landedKindOf(
  word: string | null | undefined
): ProposalLandedKind | null {
  if (!word) return null;
  const kind = normalizeObjectKind(word);
  return LANDED_KINDS.has(kind) ? (kind as ProposalLandedKind) : null;
}

/**
 * What approving a proposal of this type does to the object it names:
 * `created` for a verb that brings one into being, null for a removal (its
 * object is gone), `updated` otherwise. Read through the one verb reading,
 * {@link resolveProposalAction}.
 */
export function landedRoleOf(row: {
  proposalType?: string | null;
  data?: unknown;
}): ProposalLandedRole | null {
  const verb = resolveProposalAction(row);
  if (CREATE_VERBS.has(verb)) return "created";
  if (REMOVE_VERBS.has(verb)) return null;
  return "updated";
}

const CREATE_VERBS = new Set(["create", "start", "run"]);
const REMOVE_VERBS = new Set(["delete", "remove", "detach", "unlink"]);

/** Appends refs, one per kind and id; the first role wins. */
class LandedList {
  private readonly seen = new Set<string>();
  readonly refs: ProposalLandedRef[] = [];
  add(
    kind: ProposalLandedKind | null,
    id: unknown,
    role: ProposalLandedRole
  ): void {
    if (!kind || typeof id !== "string" || !isLikelyUUID(id)) return;
    const key = `${kind}:${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.refs.push({ kind, id, role });
  }
}

const CREATED_LISTS: ReadonlyArray<[string, ProposalLandedKind]> = [
  ["entityIds", "entity"],
  ["documentIds", "document"],
  ["sessionIds", "session"],
  ["projectIds", "project"],
  ["automationIds", "automation"],
  ["playbookIds", "playbook"],
  ["skillIds", "skill"],
  // A rule is a `skills` row (`kind: "rule"`), opened where skills are.
  ["ruleIds", "skill"],
  ["viewIds", "view"],
  ["cellIds", "cell"],
];

/**
 * What the apply's own records say landed: `data.materialized` (what revert
 * reads) and a playbook run's started sessions (`data.runResult.started`).
 * Relations, facets, links and an entity's body document are not objects a
 * person goes to, so they are not listed.
 */
export function landedFromRecord(data: unknown): ProposalLandedRef[] {
  const out = new LandedList();
  const envelope = record(data);
  const materialized = record(envelope?.materialized);
  if (materialized) {
    for (const [field, kind] of CREATED_LISTS) {
      for (const id of ids(materialized[field])) out.add(kind, id, "created");
    }
    const byOp = record(materialized.byOp);
    for (const entry of Object.values(byOp ?? {})) {
      const op = record(entry);
      if (op?.op === "create_entity" && op.linked === true) {
        out.add("entity", op.entityId, "linked");
      }
    }
    if (Array.isArray(materialized.rowPatches)) {
      for (const patch of materialized.rowPatches) {
        const p = record(patch);
        out.add(
          landedKindOf(typeof p?.kind === "string" ? p.kind : null),
          p?.id,
          "updated"
        );
      }
    }
    if (Array.isArray(materialized.propertyDiffs)) {
      for (const diff of materialized.propertyDiffs) {
        out.add("entity", record(diff)?.entityId, "updated");
      }
    }
    out.add("entity", record(materialized.merge)?.winnerId, "updated");
  }
  const started = record(envelope?.runResult)?.started;
  if (Array.isArray(started)) {
    for (const run of started) {
      out.add("session", record(run)?.sessionId, "created");
    }
  }
  return out.refs;
}

/** The stamp as stored, read defensively; null when the row has none. */
function readStamp(data: unknown): ProposalLandedRef[] | null {
  const stamp = record(data)?.[PROPOSAL_LANDED_KEY];
  if (!Array.isArray(stamp)) return null;
  const out = new LandedList();
  for (const item of stamp) {
    const ref = record(item);
    const role = ref?.role;
    if (
      typeof role === "string" &&
      (PROPOSAL_LANDED_ROLES as readonly string[]).includes(role)
    ) {
      out.add(
        landedKindOf(typeof ref?.kind === "string" ? ref.kind : null),
        ref?.id,
        role as ProposalLandedRole
      );
    }
  }
  return out.refs;
}

/** The row fields the read uses; every one is on a proposal row. */
export interface ProposalLandedRow {
  status?: string | null;
  proposalType?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  data?: unknown;
}

function isApplied(row: ProposalLandedRow): boolean {
  return APPLIED_STATUSES.has((row.status ?? "").trim().toLowerCase());
}

/** A capture or import graph: its `targetId` is a correlation id, no object. */
function isGraph(row: ProposalLandedRow): boolean {
  const data = record(row.data);
  return (
    row.targetType === "composite" ||
    (row.proposalType ?? "").endsWith(".graph") ||
    Array.isArray(data?.operations)
  );
}

/**
 * The object the request is ABOUT, before (or without) any record of what it
 * landed: its target, except where the target is no object (a graph's
 * correlation id, a run's playbook before it started a session, a create's
 * id before it exists), a facet (its entity) and a merge (its survivor).
 */
function intentObject(
  row: ProposalLandedRow
): { kind: ProposalLandedKind; id: string } | null {
  if (isPlaybookSessionStartProposal(row) || isGraph(row)) return null;
  const data = record(row.data);
  const verb = resolveProposalAction(row);
  if (verb === "merge") {
    const winner = data?.winnerId;
    return typeof winner === "string" && isLikelyUUID(winner)
      ? { kind: "entity", id: winner }
      : null;
  }
  if (normalizeObjectKind(row.targetType) === "facet") {
    const entityId = data?.entityId ?? record(data?.data)?.entityId;
    return typeof entityId === "string" && isLikelyUUID(entityId)
      ? { kind: "entity", id: entityId }
      : null;
  }
  if (verb === "create" && !isApplied(row)) return null;
  // An applied removal's object is gone.
  if (REMOVE_VERBS.has(verb) && isApplied(row)) return null;
  const kind = landedKindOf(row.targetType);
  const id = row.targetId;
  return kind && typeof id === "string" && isLikelyUUID(id)
    ? { kind, id }
    : null;
}

/**
 * What an APPLIED proposal landed: the stamp when the row has one; else what
 * its records say ({@link landedFromRecord}); else its target, with the role
 * its verb gives ({@link landedRoleOf}). Empty for a row that did not apply.
 */
export function proposalLanded(row: ProposalLandedRow): ProposalLandedRef[] {
  if (!isApplied(row)) return [];
  const stamp = readStamp(row.data);
  if (stamp) return stamp;
  const recorded = landedFromRecord(row.data);
  if (recorded.length > 0) return recorded;
  const target = landedTargetOf(row);
  return target ? [target] : [];
}

/**
 * An applied row's target as what it landed, with the role its verb gives:
 * what is left to say when nothing else recorded what the apply touched.
 */
export function landedTargetOf(
  row: ProposalLandedRow
): ProposalLandedRef | null {
  const role = landedRoleOf(row);
  const target = role && isApplied(row) ? intentObject(row) : null;
  return target && role ? { ...target, role } : null;
}

/** One object a proposal names, for every surface. */
export interface ProposalObject {
  kind: ProposalLandedKind;
  id: string;
  /**
   * What approving did to it; null when it is only what the request is about
   * (undecided, or applied with nothing recorded beyond its target).
   */
  role: ProposalLandedRole | null;
}

/**
 * THE objects a proposal names: what it landed once it applied, else the
 * object it is about. Every host opens these, so no surface derives its own
 * "created object" or "target ref".
 */
export function proposalObjectsOf(row: ProposalLandedRow): ProposalObject[] {
  const landed = proposalLanded(row);
  if (landed.length > 0) return landed;
  const intent = intentObject(row);
  return intent ? [{ ...intent, role: null }] : [];
}
