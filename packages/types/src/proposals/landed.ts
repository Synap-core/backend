/**
 * WHAT A PROPOSAL LANDED: the objects its approval created, updated or linked,
 * read from what the apply recorded on the row (`data.materialized`, a run's
 * `data.runResult`) and, for what only the executor's result names (its
 * `primaryId`, a verified effect's ids), the stamp `data.landed` the approval
 * tail writes (`stampLanded`, api). A row whose records name nothing lands its
 * target. No migration: an old row reads from the same records.
 *
 * {@link proposalObjectsOf} is the one answer the hosts open (pod admin, web,
 * relay switch their own derivations to it): what it landed once applied, else
 * the object the request is about.
 *
 * Pure.
 */

import { resolveProposalAction } from "./action.js";
import { isPlaybookSessionStartProposal } from "./session-start.js";
import { isLikelyUUID } from "./proposal-utils.js";
import { normalizeObjectKind } from "../vocabulary/object-kinds.js";

/** The key the executor's refs live under in `proposals.data`. */
export const PROPOSAL_LANDED_KEY = "landed" as const;

export const PROPOSAL_LANDED_ROLES = ["created", "updated", "linked"] as const;
export type ProposalLandedRole = (typeof PROPOSAL_LANDED_ROLES)[number];

/** What approving did to a landed object, as a vocabulary verb token. */
export const LANDED_ROLE_VERB: Record<ProposalLandedRole, string> = {
  created: "create",
  updated: "update",
  linked: "link",
};

/** The object kinds a landed ref may name: those a host opens and the pod resolves. */
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
  "track",
  "agent",
  "tool",
  "channel",
] as const;
export type ProposalLandedKind = (typeof PROPOSAL_LANDED_KINDS)[number];

const LANDED_KINDS: ReadonlySet<string> = new Set(PROPOSAL_LANDED_KINDS);

export interface ProposalLandedRef {
  kind: ProposalLandedKind;
  id: string;
  role: ProposalLandedRole;
}

const APPLIED_STATUSES = new Set([
  "approved",
  "auto_approved",
  "partially_approved",
]);

/** The row's change is in storage. */
export function isProposalApplied(row: { status?: string | null }): boolean {
  return APPLIED_STATUSES.has((row.status ?? "").trim().toLowerCase());
}

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

const CREATE_VERBS = new Set(["create", "start", "run"]);
const REMOVE_VERBS = new Set(["delete", "remove", "detach", "unlink"]);

/**
 * What approving a proposal of this type does to the object it names, by the
 * one verb reading ({@link resolveProposalAction}): null for a removal.
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

/** Appends each ref once by kind and id; the first role wins. */
export function pushLanded(
  out: ProposalLandedRef[],
  kind: ProposalLandedKind | null,
  id: unknown,
  role: ProposalLandedRole
): void {
  if (!kind || typeof id !== "string" || !isLikelyUUID(id)) return;
  if (out.some((r) => r.kind === kind && r.id === id)) return;
  out.push({ kind, id, role });
}

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

/** One op of an applied composite, as `data.materialized.byOp` records it. */
export interface MaterializedOp {
  ref: string;
  op: string;
  id: string;
  /** It linked a row that already existed instead of creating one. */
  linked: boolean;
  revertedAt?: string;
}

/** THE reader of `data.materialized.byOp`: each op with the real id it produced. */
export function readMaterializedOps(materialized: unknown): MaterializedOp[] {
  const byOp = record(record(materialized)?.byOp);
  if (!byOp) return [];
  return Object.entries(byOp).flatMap(([ref, entry]): MaterializedOp[] => {
    const e = record(entry);
    const idKey = e
      ? BY_OP_ID_KEYS.find((k) => typeof e[k] === "string")
      : undefined;
    if (!e || !idKey || typeof e.op !== "string") return [];
    return [
      {
        ref,
        op: e.op,
        id: e[idKey] as string,
        linked: e.linked === true || e.preExisting === true,
        ...(typeof e.revertedAt === "string"
          ? { revertedAt: e.revertedAt }
          : {}),
      },
    ];
  });
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
  ["workspaceIds", "workspace"],
];

/**
 * What the apply's records say landed. Relations, facets, links, cells and an
 * entity's body document are not objects a host opens, so they are left out.
 */
export function landedFromRecord(data: unknown): ProposalLandedRef[] {
  const out: ProposalLandedRef[] = [];
  const envelope = record(data);
  const materialized = record(envelope?.materialized);
  if (materialized) {
    for (const [field, kind] of CREATED_LISTS) {
      for (const id of ids(materialized[field]))
        pushLanded(out, kind, id, "created");
    }
    for (const op of readMaterializedOps(materialized)) {
      if (op.op === "create_entity" && op.linked) {
        pushLanded(out, "entity", op.id, "linked");
      }
    }
    if (Array.isArray(materialized.rowPatches)) {
      for (const patch of materialized.rowPatches) {
        const p = record(patch);
        const kind = typeof p?.kind === "string" ? p.kind : null;
        pushLanded(out, landedKindOf(kind), p?.id, "updated");
      }
    }
    if (Array.isArray(materialized.propertyDiffs)) {
      for (const diff of materialized.propertyDiffs) {
        pushLanded(out, "entity", record(diff)?.entityId, "updated");
      }
    }
    pushLanded(out, "entity", record(materialized.merge)?.winnerId, "updated");
  }
  const started = record(envelope?.runResult)?.started;
  if (Array.isArray(started)) {
    for (const run of started) {
      pushLanded(out, "session", record(run)?.sessionId, "created");
    }
  }
  const stamp = envelope?.[PROPOSAL_LANDED_KEY];
  if (Array.isArray(stamp)) {
    for (const item of stamp) {
      const ref = record(item);
      const role = ref?.role;
      if (
        typeof role === "string" &&
        (PROPOSAL_LANDED_ROLES as readonly string[]).includes(role)
      ) {
        const kind = typeof ref?.kind === "string" ? ref.kind : null;
        pushLanded(
          out,
          landedKindOf(kind),
          ref?.id,
          role as ProposalLandedRole
        );
      }
    }
  }
  return out;
}

/** The row fields the read uses; every one is on a proposal row. */
export interface ProposalLandedRow {
  status?: string | null;
  proposalType?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  data?: unknown;
}

/** A capture or import graph: its `targetId` is a correlation id, no object. */
function isGraph(row: ProposalLandedRow): boolean {
  return (
    row.targetType === "composite" ||
    (row.proposalType ?? "").endsWith(".graph") ||
    Array.isArray(record(row.data)?.operations)
  );
}

/**
 * The object the request is ABOUT: its target, except where the target is no
 * object (a graph's correlation id, a run's playbook, a create's id before it
 * exists, a removal's once applied), a facet (its entity), a merge (its
 * survivor).
 */
function intentObject(
  row: ProposalLandedRow
): { kind: ProposalLandedKind; id: string } | null {
  if (isPlaybookSessionStartProposal(row) || isGraph(row)) return null;
  const data = record(row.data);
  const verb = resolveProposalAction(row);
  const applied = isProposalApplied(row);
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
  if (verb === "create" && !applied) return null;
  if (REMOVE_VERBS.has(verb) && applied) return null;
  const kind = landedKindOf(row.targetType);
  const id = row.targetId;
  return kind && typeof id === "string" && isLikelyUUID(id)
    ? { kind, id }
    : null;
}

/**
 * What an APPLIED proposal landed: its records and stamp, else its target with
 * the role its verb gives. Empty for a row that did not apply.
 */
export function proposalLanded(row: ProposalLandedRow): ProposalLandedRef[] {
  if (!isProposalApplied(row)) return [];
  const recorded = landedFromRecord(row.data);
  if (recorded.length > 0) return recorded;
  const role = landedRoleOf(row);
  const target = role ? intentObject(row) : null;
  return target && role ? [{ ...target, role }] : [];
}

/** One object a proposal names, for every host. */
export interface ProposalObject {
  kind: ProposalLandedKind;
  id: string;
  /** What approving did to it; null when it is only what the request is about. */
  role: ProposalLandedRole | null;
}

/** THE objects a proposal names: what it landed once applied, else what it is about. */
export function proposalObjectsOf(row: ProposalLandedRow): ProposalObject[] {
  const landed = proposalLanded(row);
  if (landed.length > 0) return landed;
  const intent = intentObject(row);
  return intent ? [{ ...intent, role: null }] : [];
}
