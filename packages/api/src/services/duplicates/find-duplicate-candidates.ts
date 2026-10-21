/**
 * THE duplicate door (FB1020 B2, founder-approved 2026-10-21).
 *
 * ONE question, asked by every create door at FILE time: "does the thing this
 * write would create already exist — as a record, or in the caller's own
 * pending queue?" ONE answer shape, `DuplicateCheck`
 * (`@synap-core/types/proposals`), persisted on the proposal and shown on the
 * review card. What a door DOES with the answer is the door's (Salesforce's
 * split of matching rules from duplicate rules):
 *   - a strong identity atom on a visible record → the entity door merges
 *     (the only automatic outcome; `IdentityResolutionService` decides it);
 *   - a name that IS the object's identity (a project's normalized name, a
 *     playbook's name in its space — both unique by construction) → reused;
 *   - every other hit is `possible`: an agent's write is FILED ANYWAY as a
 *     proposal (`POSSIBLE_DUPLICATE`), and the reviewer decides with the
 *     existing verbs; a person's own create is warned, never blocked.
 *
 * Legs (the meaning-based leg — embeddings — is LATER, B2 of the plan):
 *   1. records  — strong identity + exact same-kind name through
 *                 `resolveIdentity` (entities), the project matcher (projects),
 *                 the pod-wide slug probe (kinds). Never re-derived here.
 *   2. pending  — the caller's OWN pending creates (owner floor below), same
 *                 kind, matched on the same normalized name or an overlapping
 *                 strong identity atom (`normalizeIdentitySignal`).
 * The exact PAYLOAD hash against pending rows stays where the unique index is
 * (`insertPendingProposal`, migration 0208): an identical create returns the
 * existing proposal before a second row exists.
 *
 * A failed leg is `unchecked`, never `clear` (an empty result and a failed read
 * are different facts). Same kind only (B2d): a note and a decision with one
 * title are not duplicates.
 *
 * Replaces: `findPendingSignalMatches` (capture's pending scan, strong signals
 * only and capture graphs only), the capture door's weak auto-link, the entity
 * door's weak refusal, the playbook term-overlap refusal and
 * `ProjectNearDuplicateError`.
 */
import {
  and,
  desc,
  eq,
  inArray,
  proposals,
  ProposalStatus,
  ProfileRepository,
  extractIdentitySignals,
  findProjectDedupCandidates,
  normalizeIdentitySignal,
  normalizeProjectName,
  resolveIdentity,
  type db as Database,
  type IdentitySignal,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import {
  DUPLICATE_CHECK_MAX_CANDIDATES,
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
  proposalId: string,
  profileSlug: unknown,
  title: unknown,
  properties: unknown
): PendingCreate | null {
  if (typeof profileSlug !== "string" || profileSlug.length === 0) return null;
  const name = typeof title === "string" ? title : null;
  return {
    proposalId,
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
): Promise<PendingCreate[]> {
  const rows = await database
    .select({
      id: proposals.id,
      targetType: proposals.targetType,
      proposalType: proposals.proposalType,
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
          row.id,
          op.profileSlug,
          op.title,
          op.properties
        );
        if (create) creates.push(create);
      }
      continue;
    }
    const record = asRecord(data.data);
    if (!record) continue;
    if (row.targetType === "entity") {
      const create = entityCreate(
        row.id,
        record.profileSlug,
        record.title,
        record.properties
      );
      if (create) creates.push(create);
    } else if (row.targetType === "playbook" || row.targetType === "project") {
      const name = typeof record.name === "string" ? record.name : null;
      creates.push({
        proposalId: row.id,
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
  return creates;
}

/** Fold candidates into the persisted answer: capped, honest about clipping. */
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
      recordScope: SQL;
      /** Capture graphs: the op this check is about (stamped on its candidates). */
      forRef?: string;
      /** Preloaded pending queue (a capture checks many items against one read). */
      pending?: PendingCreate[];
    }
  | {
      subject: "playbook";
      userId: string;
      name: string;
      pending?: PendingCreate[];
    }
  | {
      subject: "project";
      userId: string;
      name: string;
      pending?: PendingCreate[];
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
  query: { userId: string; pending?: PendingCreate[] }
): Promise<PendingCreate[]> {
  return query.pending ?? loadOwnPendingCreates(database, query.userId);
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
        userScope: query.recordScope,
        limit: DUPLICATE_CHECK_MAX_CANDIDATES,
      });
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
    // A strong match is the entity door's to merge (or, when the caller cannot
    // see it, to create beside without leaking it): nothing pending to add.
    if (identity?.match !== "strong") {
      try {
        const wantedName = nameKey(query.title);
        const wantedSignals = signalKeysOf(query.signals);
        for (const p of await pendingLeg(database, query)) {
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
      for (const p of await pendingLeg(database, query)) {
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
      for (const p of await pendingLeg(database, query)) {
        if (p.subject !== "playbook" || !wanted || p.nameKey !== wanted)
          continue;
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
