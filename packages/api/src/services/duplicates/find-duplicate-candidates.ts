/**
 * THE duplicate door. One question, asked by every create door at file time:
 * "does the thing this write would create already exist, as a record or in the
 * caller's own pending queue?" One answer shape, `DuplicateCheck`
 * (`@synap-core/types/proposals`), persisted on the proposal and shown on the review
 * card. What a door does with the answer is the door's:
 *   - a strong identity atom on a visible record: the entity door merges (the only
 *     automatic outcome; `IdentityResolutionService` decides it);
 *   - a name that is the object's identity (a project's normalized name, a playbook's
 *     name in its space): reused;
 *   - every other hit is `possible`: an agent's write is filed anyway as a proposal
 *     (`POSSIBLE_DUPLICATE`) and the reviewer decides; a person's own create is warned,
 *     never blocked.
 * Legs: records (strong identity + exact same-kind name via `resolveIdentity`, the
 * project matcher, the pod-wide kind slug probe) and pending (the caller's own pending
 * creates, same kind, same normalized name or an overlapping strong atom).
 * The exact payload hash stays in `insertPendingProposal` (migration 0208).
 * A failed leg is `unchecked`, never `clear`. Same kind only.
 */
import {
  and,
  desc,
  eq,
  inArray,
  entities,
  proposals,
  ProposalStatus,
  ProfileRepository,
  extractIdentitySignals,
  findProjectDedupCandidates,
  normalizeIdentitySignal,
  normalizeProjectName,
  resolveIdentity,
  sampleEntityWhere,
  type db as Database,
  type IdentitySignal,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import {
  DUPLICATE_CHECK_MAX_CANDIDATES,
  readDuplicateCheck,
  type DuplicateCandidate,
  type DuplicateCheck,
  type DuplicateSubjectType,
} from "@synap-core/types/proposals";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { createLogger } from "@synap-core/core";
import { authoredByUser } from "../agent-identity-service.js";

const logger = createLogger({ module: "duplicate-door" });

type Db = typeof Database;
type IdentityResolution = Awaited<ReturnType<typeof resolveIdentity>>;

/** How many of the caller's newest pending rows the pending leg reads. */
const PENDING_SCAN_LIMIT = 200;

/** Composite proposal types whose `operations[]` carry create_entity ops. */
const GRAPH_PROPOSAL_TYPES = ["capture.graph", "import.graph"] as const;

/** One create waiting in the caller's queue, reduced to what the door compares. */
export interface PendingCreate {
  proposalId: string;
  proposalType: string;
  /** The space the proposal is filed in (null = pod-wide). */
  workspaceId: string | null;
  /** A graph op's stable ref, when the create sits inside a capture/import. */
  entityRef?: string;
  subject: Exclude<DuplicateSubjectType, "kind">;
  /** An entity's profile slug; the subject type otherwise. */
  kind: string;
  title: string | null;
  /** Normalized name (see {@link nameKey}); empty when the create has none. */
  nameKey: string;
  /** `type:value` of every normalized strong identity atom it carries. */
  signalKeys: Set<string>;
}

/** Same name, the way the door compares names: trimmed, spaces collapsed, case-folded. */
export function nameKey(name: string | null | undefined): string {
  return typeof name === "string"
    ? name.trim().replace(/\s+/g, " ").toLowerCase()
    : "";
}

function signalKeysOf(signals: IdentitySignal[]): Set<string> {
  const keys = new Set<string>();
  for (const signal of signals) {
    if (!signal?.type || typeof signal.value !== "string") continue;
    if (!signal.value.trim()) continue;
    keys.add(
      `${signal.type}:${normalizeIdentitySignal(signal.type, signal.value)}`
    );
  }
  return keys;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entityCreate(
  row: { id: string; proposalType: string; workspaceId: string | null },
  profileSlug: unknown,
  title: unknown,
  properties: unknown
): PendingCreate | null {
  if (typeof profileSlug !== "string" || profileSlug.length === 0) return null;
  const name = typeof title === "string" ? title : null;
  return {
    proposalId: row.id,
    proposalType: row.proposalType,
    workspaceId: row.workspaceId,
    subject: "entity",
    kind: profileSlug,
    title: name,
    nameKey: nameKey(name),
    signalKeys: signalKeysOf(
      extractIdentitySignals(
        (asRecord(properties) ?? undefined) as
          Record<string, unknown> | undefined,
        { kind: profileSlug }
      )
    ),
  };
}

/**
 * The caller's pending queue as the door read it. `truncated`: the queue is
 * longer than the scan ({@link PENDING_SCAN_LIMIT} newest rows), so "no
 * pending twin" was not checked against all of it — the answer is then never
 * `clear` (FB1020 review S11).
 */
export interface PendingQueue {
  creates: PendingCreate[];
  truncated: boolean;
}

/**
 * The caller's OWN pending creates — the ONE pending scan of the duplicate
 * door. OWNER FLOOR, unchanged from the scan it replaces (`authoredByUser`,
 * the ONE "this proposal is mine" predicate): rows the person authored, or
 * that their OWN agents authored. Never a workspace
 * floor — that would read a teammate's unreviewed queue. STRICT pending: an
 * approved create is a record, and leg 1 sees it.
 */
export async function loadOwnPendingCreates(
  database: Db,
  userId: string
): Promise<PendingQueue> {
  const rows = await database
    .select({
      id: proposals.id,
      targetType: proposals.targetType,
      proposalType: proposals.proposalType,
      workspaceId: proposals.workspaceId,
      data: proposals.data,
    })
    .from(proposals)
    .where(
      and(
        authoredByUser(userId),
        eq(proposals.status, ProposalStatus.PENDING),
        inArray(proposals.proposalType, ["create", ...GRAPH_PROPOSAL_TYPES])
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(PENDING_SCAN_LIMIT);

  const creates: PendingCreate[] = [];
  for (const row of rows) {
    const data = asRecord(row.data) ?? {};
    if (
      (GRAPH_PROPOSAL_TYPES as readonly string[]).includes(row.proposalType)
    ) {
      const ops = Array.isArray(data.operations)
        ? (data.operations as CompositeProposalOperation[])
        : [];
      for (const op of ops) {
        // An op that LINKS an existing record proposes nothing new.
        if (op.op !== "create_entity" || op.existingEntityId) continue;
        const create = entityCreate(
          row,
          op.profileSlug,
          op.title,
          op.properties
        );
        if (create)
          creates.push(op.ref ? { ...create, entityRef: op.ref } : create);
      }
      continue;
    }
    const record = asRecord(data.data);
    if (!record) continue;
    if (row.targetType === "entity") {
      const create = entityCreate(
        row,
        record.profileSlug,
        record.title,
        record.properties
      );
      if (create) creates.push(create);
    } else if (row.targetType === "playbook" || row.targetType === "project") {
      const name = typeof record.name === "string" ? record.name : null;
      creates.push({
        proposalId: row.id,
        proposalType: row.proposalType,
        workspaceId: row.workspaceId,
        subject: row.targetType,
        kind: row.targetType,
        title: name,
        nameKey:
          row.targetType === "project"
            ? normalizeProjectName(name ?? "")
            : nameKey(name),
        signalKeys: new Set(),
      });
    }
  }
  return { creates, truncated: rows.length >= PENDING_SCAN_LIMIT };
}

/**
 * Fold candidates into the persisted answer, capped; says when it was clipped.
 * `failed` — a leg failed OR could not look at everything (a truncated
 * pending scan): with no candidate that is `unchecked`, never `clear`.
 */
export function toDuplicateCheck(
  subject: DuplicateSubjectType,
  candidates: DuplicateCandidate[],
  failed: boolean
): DuplicateCheck {
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.ref}:${c.id}:${c.forRef ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    status: unique.length > 0 ? "possible" : failed ? "unchecked" : "clear",
    subject,
    candidates: unique.slice(0, DUPLICATE_CHECK_MAX_CANDIDATES),
    ...(unique.length > DUPLICATE_CHECK_MAX_CANDIDATES
      ? { truncated: true }
      : {}),
  };
}

/** Merge per-item checks (a capture graph) into the proposal's one answer. */
export function mergeDuplicateChecks(
  subject: DuplicateSubjectType,
  checks: DuplicateCheck[]
): DuplicateCheck {
  return toDuplicateCheck(
    subject,
    checks.flatMap((c) => c.candidates),
    checks.some((c) => c.status === "unchecked")
  );
}

export type DuplicateQuery =
  | {
      subject: "entity";
      userId: string;
      /** Absent when the create names no kind yet: only strong identity applies. */
      profileSlug: string | undefined;
      title: string | null | undefined;
      signals: IdentitySignal[];
      /**
       * Rows of OTHER kinds that count as the same thing — a role create's
       * applicable kinds (the role sits on them). Same kind only otherwise.
       */
      alsoKinds?: string[];
      /** Visibility predicate for the record leg's weak path (REQUIRED for it to run). */
      recordScope: SQL | undefined;
      /** Capture graphs: the op this check is about (stamped on its candidates). */
      forRef?: string;
      /** Preloaded pending queue (a capture checks many items against one read). */
      pending?: PendingQueue;
    }
  | {
      subject: "playbook";
      userId: string;
      name: string;
      /** A playbook's name is unique per space: only that space's queue counts. */
      workspaceId: string | null;
      pending?: PendingQueue;
    }
  | {
      subject: "project";
      userId: string;
      name: string;
      pending?: PendingQueue;
    }
  | { subject: "kind"; userId: string; slug: string };

export interface DuplicateAnswer {
  check: DuplicateCheck;
  /** Entities: the resolver's verdict, so the door merges on a strong match without asking twice. */
  identity?: IdentityResolution | null;
  /** Projects: the record whose normalized name IS this project's identity (reuse it). */
  sameIdentity?: { id: string; name: string };
}

async function pendingLeg(
  database: Db,
  query: { userId: string; pending?: PendingQueue },
  onTruncated: () => void
): Promise<PendingCreate[]> {
  const queue =
    query.pending ?? (await loadOwnPendingCreates(database, query.userId));
  if (queue.truncated) onTruncated();
  return queue.creates;
}

/**
 * THE door. Every create door calls it at file time; see the file header for
 * what each answer means. Never throws for a failed lookup: a failed leg
 * reports `unchecked` (logged), so a hiccup never blocks a write and never
 * reads as "no duplicates".
 */
export async function findDuplicateCandidates(
  database: Db,
  query: DuplicateQuery
): Promise<DuplicateAnswer> {
  const candidates: DuplicateCandidate[] = [];
  let failed = false;
  const fail = (leg: string, err: unknown) => {
    failed = true;
    logger.warn(
      { err, subject: query.subject, leg },
      "duplicate door leg failed"
    );
  };
  // A pending queue longer than the scan was not fully looked at.
  const truncatedPending = () => {
    failed = true;
  };

  if (query.subject === "entity") {
    const kinds = new Set(
      [query.profileSlug, ...(query.alsoKinds ?? [])].filter(
        (k): k is string => typeof k === "string" && k.length > 0
      )
    );
    const tag = query.forRef
      ? {
          forRef: query.forRef,
          ...(query.title ? { forTitle: query.title } : {}),
        }
      : {};
    let identity: IdentityResolution | null = null;
    try {
      identity = await resolveIdentity(database, {
        userId: query.userId,
        kindSlug: query.profileSlug,
        name: query.title ?? null,
        signals: query.signals,
        // Same kind only, IN the query (FB1020 review S1): the weak path
        // orders oldest-first and limits BEFORE any kind filter, so five older
        // same-name rows of other kinds crowded a newer same-kind twin out and
        // the answer read `clear`.
        userScope:
          query.recordScope && kinds.size > 0
            ? and(query.recordScope, inArray(entities.type, [...kinds]))
            : query.recordScope,
        limit: DUPLICATE_CHECK_MAX_CANDIDATES,
      });
      // Never merge onto DEMO data silently (founder default 1): a strong
      // match on a sample-only record the caller can see is a `possible`
      // twin, marked as sample, for a person to decide. The read is floored
      // by `recordScope`, so an invisible record is never named here (the
      // entity door then creates beside it, as before).
      if (identity.match === "strong" && identity.entity && query.recordScope) {
        const strong = identity.entity;
        let demo: boolean | "unknown";
        try {
          const [row] = await database
            .select({ id: entities.id })
            .from(entities)
            .where(
              and(
                eq(entities.id, strong.id),
                query.recordScope,
                sampleEntityWhere()
              )
            )
            .limit(1);
          demo = Boolean(row);
        } catch (err) {
          fail("sample", err);
          demo = "unknown";
        }
        if (demo === true) {
          candidates.push({
            ref: "record",
            id: strong.id,
            kind: strong.type,
            title: strong.title ?? null,
            why: "same_identity",
            sample: true,
            ...tag,
          });
        }
        // Unknown ⇒ no merge either (a failed read is `unchecked`, never a
        // guess that the record is real).
        if (demo !== false) {
          identity = { match: null, candidates: [], crossKindCandidates: [] };
        }
      }
      if (identity.match !== "strong") {
        const sameKind = identity.candidates.filter(
          (c) => c.type === query.profileSlug
        );
        const otherKinds = query.alsoKinds?.length
          ? identity.crossKindCandidates.filter((c) =>
              query.alsoKinds!.includes(c.type)
            )
          : [];
        for (const c of [...sameKind, ...otherKinds]) {
          candidates.push({
            ref: "record",
            id: c.id,
            kind: c.type,
            title: c.title ?? null,
            why: "same_name",
            ...tag,
          });
        }
      }
    } catch (err) {
      fail("records", err);
    }
    // Mark the record candidates that are demo data (founder default 1): "use
    // existing" on one would put real work on a row every list hides.
    const unmarked = candidates.filter((c) => c.ref === "record" && !c.sample);
    if (unmarked.length > 0) {
      try {
        const sampleRows = await database
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              inArray(
                entities.id,
                unmarked.map((c) => c.id)
              ),
              sampleEntityWhere()
            )
          );
        const sampleIds = new Set(sampleRows.map((r) => r.id));
        for (const c of unmarked) if (sampleIds.has(c.id)) c.sample = true;
      } catch (err) {
        fail("sample", err);
      }
    }
    // A strong match is the entity door's to merge (or, when the caller cannot
    // see it, to create beside without leaking it): nothing pending to add.
    if (identity?.match !== "strong") {
      try {
        const wantedName = nameKey(query.title);
        const wantedSignals = signalKeysOf(query.signals);
        for (const p of await pendingLeg(database, query, truncatedPending)) {
          if (p.subject !== "entity" || !kinds.has(p.kind)) continue;
          const sameIdentity = [...p.signalKeys].some((k) =>
            wantedSignals.has(k)
          );
          const sameName = wantedName.length > 0 && p.nameKey === wantedName;
          if (!sameIdentity && !sameName) continue;
          candidates.push({
            ref: "proposal",
            id: p.proposalId,
            kind: p.kind,
            title: p.title,
            why: sameIdentity ? "same_identity" : "same_name",
            ...tag,
          });
        }
      } catch (err) {
        fail("pending", err);
      }
    }
    return {
      check: toDuplicateCheck("entity", candidates, failed),
      identity,
    };
  }

  if (query.subject === "project") {
    let sameIdentity: DuplicateAnswer["sameIdentity"];
    try {
      const match = await findProjectDedupCandidates(database, {
        userId: query.userId,
        name: query.name,
      });
      if (match.exact) {
        sameIdentity = { id: match.exact.id, name: match.exact.name };
      }
      for (const near of match.near) {
        candidates.push({
          ref: "record",
          id: near.id,
          kind: "project",
          title: near.name,
          why: "similar_name",
        });
      }
    } catch (err) {
      fail("records", err);
    }
    try {
      const wanted = normalizeProjectName(query.name);
      for (const p of await pendingLeg(database, query, truncatedPending)) {
        if (p.subject !== "project" || !wanted || p.nameKey !== wanted)
          continue;
        candidates.push({
          ref: "proposal",
          id: p.proposalId,
          kind: "project",
          title: p.title,
          why: "same_name",
        });
      }
    } catch (err) {
      fail("pending", err);
    }
    return {
      check: toDuplicateCheck("project", candidates, failed),
      ...(sameIdentity ? { sameIdentity } : {}),
    };
  }

  if (query.subject === "playbook") {
    // A playbook's name is its identity in its space (unique index 0227): the
    // playbook door reuses that record itself. What it cannot see is the same
    // playbook still WAITING for review — every agent playbook create is a
    // proposal (AGENT_STRUCTURE_WRITE), so that is where its twins pile up.
    try {
      const wanted = nameKey(query.name);
      for (const p of await pendingLeg(database, query, truncatedPending)) {
        if (p.subject !== "playbook" || !wanted || p.nameKey !== wanted)
          continue;
        if ((p.workspaceId ?? null) !== (query.workspaceId ?? null)) continue;
        candidates.push({
          ref: "proposal",
          id: p.proposalId,
          kind: "playbook",
          title: p.title,
          why: "same_name",
        });
      }
    } catch (err) {
      fail("pending", err);
    }
    return { check: toDuplicateCheck("playbook", candidates, failed) };
  }

  // kind — a slug is pod-wide: the same slug owned by another space is the
  // same concept seen through two lenses (the CRM `partner` / `finding` twins).
  try {
    const elsewhere = await new ProfileRepository(
      database
    ).findActiveBySlugAnyScope(query.slug);
    for (const row of elsewhere) {
      candidates.push({
        ref: "record",
        id: row.id,
        kind: "kind",
        title: row.displayName,
        why: "same_name",
      });
    }
  } catch (err) {
    fail("records", err);
  }
  return { check: toDuplicateCheck("kind", candidates, failed) };
}

/** A pending create that carries one of the asked strong identity atoms. */
export interface PendingIdentityMatch {
  proposalId: string;
  proposalType: string;
  entityRef?: string;
  entityTitle?: string;
  profileSlug?: string;
  /** The normalized atoms that matched. */
  matchedSignals: Array<{ type: string; value: string }>;
}

/**
 * The door's pending leg for an identity LOOKUP (`synap_resolve_identity`,
 * `POST /identity/resolve`): which of the caller's own pending creates already
 * carry one of these strong atoms. Advisory — a pending proposal can still be
 * rejected, so a caller never links to it. Same owner-floored scan as
 * {@link findDuplicateCandidates}; there is no second one.
 */
export async function findPendingIdentityMatches(
  database: Db,
  userId: string,
  signals: IdentitySignal[]
): Promise<PendingIdentityMatch[]> {
  const wanted = signalKeysOf(signals);
  if (wanted.size === 0) return [];
  const matches: PendingIdentityMatch[] = [];
  for (const p of (await loadOwnPendingCreates(database, userId)).creates) {
    if (p.subject !== "entity") continue;
    const hit = [...p.signalKeys].filter((k) => wanted.has(k));
    if (hit.length === 0) continue;
    matches.push({
      proposalId: p.proposalId,
      proposalType: p.proposalType,
      ...(p.entityRef ? { entityRef: p.entityRef } : {}),
      ...(p.title ? { entityTitle: p.title } : {}),
      profileSlug: p.kind,
      matchedSignals: hit.map((key) => {
        const at = key.indexOf(":");
        return { type: key.slice(0, at), value: key.slice(at + 1) };
      }),
    });
  }
  return matches;
}

/**
 * The twin RECORDS a review card SHOWED, read from the proposal's persisted
 * `duplicateCheck` (FB1020 BLOCKER-2): `single` for a single create, `byRef`
 * per proposed item of a capture/import graph (keyed by the candidate's
 * `forRef` = the op's `ref`, the key `identityResolutionByRef` uses). The
 * approval hands them to the entity door (`approvalReviewedTwinIds`): a plain
 * approve on a twin the reviewer saw keeps both; a twin not shown refuses so
 * the card asks. Pending-proposal candidates are not records and never count.
 */
export function twinsShownOnCard(proposalData: unknown): {
  single: string[];
  byRef: Record<string, string[]>;
} {
  const check = readDuplicateCheck(proposalData);
  const single: string[] = [];
  const byRef: Record<string, string[]> = {};
  for (const c of check?.candidates ?? []) {
    if (c.ref !== "record") continue;
    if (c.forRef) (byRef[c.forRef] ??= []).push(c.id);
    else single.push(c.id);
  }
  return { single, byRef };
}
