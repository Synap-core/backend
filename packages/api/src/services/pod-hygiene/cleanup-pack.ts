/**
 * Pod hygiene CLEANUP PACK — the scanner half: a reviewable pack PROPOSED to the
 * human, never applied.
 *
 * Per human owner, ONE pending `pod_hygiene/cleanup_pack` proposal (schema 2,
 * the item model in `@synap-core/types/pod-hygiene`) listing:
 *   - `close_session`  work sessions the reaper already marked `stale`, with no
 *                      activity for STALE_SESSION_DAYS;
 *   - `retire_profile` active, non-system kinds older than KIND_MIN_AGE_DAYS with
 *                      zero live entities pod-wide AND a retire preflight that
 *                      passes — a kind it would refuse is counted, never packed,
 *                      so a reviewer never approves a guaranteed refusal.
 * Old proposals and never-run automations are NOT packed: an expiry cannot be
 * taken back, and the automation-health warden owns never-run automations.
 *
 * Lives in @synap/api because the session KIND is an api-owned SSOT; the jobs
 * worker reaches it through the `registerCleanupPackRunner` IoC slot.
 *
 * ── Why ONE pack with per-item reject, not N proposals ───────────────────────
 * The reviewer's unit of work is "tidy my pod", and `proposals.rejectItem` is
 * generic over any proposal's `data`. A pack only retires, each item is
 * independent, and one refused item must not undo the others — so the
 * composite plan machinery (all-or-none compensation for creates) does not fit.
 *
 * ── Don't nag (item-level, modelled on the automation-health warden) ─────────
 * Refs are id-keyed (`stableItemRef`), so a decision about an object outlives
 * the pack it was made in. See `suppressedRefs` for the rule.
 *
 * ── Supersede ────────────────────────────────────────────────────────────────
 * A pack left undecided for SUPERSEDE_AFTER_DAYS is WITHDRAWN — the filer
 * recalling its own stale ask — with `data.supersededBy`, WITHOUT `reviewedAt`,
 * and whatever is still worth tidying is refiled fresh.
 *
 * Owner rule: the session's `userId`; a workspace kind's workspace OWNER, a
 * user-scoped kind's `userId`. Shared kinds with no home workspace have no single
 * human owner and are NOT packed (counted). Agent principals never own a pack.
 */

import {
  db,
  and,
  eq,
  lt,
  gte,
  ne,
  or,
  inArray,
  drizzleSql,
  focusSessions,
  proposals,
  profiles,
  entities,
  workspaces,
  users,
  ProposalStatus,
  ProfileScope,
  insertPendingProposal,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  CLEANUP_PACK_SCHEMA,
  CLEANUP_PACK_ACTIONS,
  CLEANUP_ACTION_SUBJECT_KIND,
  CLEANUP_ACTION_REVERSIBLE,
  KEEP_DAYS,
  MAX_ITEMS_PER_ACTION,
  MAX_ITEMS_PER_PACK,
  SUPERSEDE_AFTER_DAYS,
  describeCleanupAction,
  readPackItems,
  stableItemRef,
  type CleanupPackAction,
  type CleanupPackItemV2,
} from "@synap-core/types/pod-hygiene";
import { emitSideEffects } from "@synap/events";
import { discardProposalSourceBlob } from "../../utils/store-entity-source-blob.js";
import { markProposalNotificationsActioned } from "../../notifications/mark-proposal-notifications-actioned.js";
import { sessionKindWhere } from "../focus-sessions/session-kind.js";
import {
  inspectProfileRetirement,
  profilesWithPendingRetire,
} from "./retire-profile.js";

const logger = createLogger({ module: "pod-hygiene-cleanup-pack" });

export const STALE_SESSION_DAYS = 30;
/** Read by the diagnose section. Old proposals are not packed: an expiry cannot be taken back. */
export const OLD_PROPOSAL_DAYS = 30;
export const KIND_MIN_AGE_DAYS = 30;
/** A refused item is left to settle this long before it is proposed again. */
export const REFUSED_SETTLE_DAYS = 7;
/** A pack rejected whole silences every item in it this long. */
export const REJECTED_PACK_SILENCE_DAYS = 30;
/** Safety cap: packs filed in one run. */
export const MAX_PACKS_PER_RUN = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

const PACK_REASONING =
  "Found by the pod hygiene scan. Nothing is applied until you approve, and every item is checked again when you do. Leaving an item out keeps it: it will not be proposed again for a while.";

/** One packable item and the human who reviews it. */
export interface CleanupCandidate {
  item: CleanupPackItemV2;
  ownerUserId: string;
}

/** The stored `data` of a schema-2 pack — no `changeType`, no `properties`. */
export interface CleanupPackData {
  schema: typeof CLEANUP_PACK_SCHEMA;
  sourceId: string;
  summary: string;
  reasoning: string;
  items: CleanupPackItemV2[];
  truncated: Record<CleanupPackAction, number>;
  thresholds: {
    staleSessionDays: number;
    kindMinAgeDays: number;
    keepDays: typeof KEEP_DAYS;
    refusedSettleDays: number;
    rejectedPackSilenceDays: number;
    supersedeAfterDays: number;
  };
  generatedAt: string;
}

// ── Pure ─────────────────────────────────────────────────────────────────────

const iso = (value: Date | string): string => new Date(value).toISOString();

/** Longest-idle first: last activity when known, else creation. */
function idleSince(item: CleanupPackItemV2): number {
  return Date.parse(item.evidence.lastActivityAt ?? item.evidence.createdAt);
}

/**
 * PURE: candidates → the pack's items. Oldest first per action, at most
 * MAX_ITEMS_PER_ACTION per action and MAX_ITEMS_PER_PACK in all; everything cut
 * is counted in `truncated`, never dropped silently.
 */
export function buildCleanupPackItems(
  candidates: readonly CleanupCandidate[]
): {
  items: CleanupPackItemV2[];
  truncated: Record<CleanupPackAction, number>;
} {
  const items: CleanupPackItemV2[] = [];
  const truncated = {} as Record<CleanupPackAction, number>;
  for (const action of CLEANUP_PACK_ACTIONS) {
    const mine = candidates
      .map((c) => c.item)
      .filter((i) => i.action === action)
      .sort((a, b) => idleSince(a) - idleSince(b));
    const take = Math.min(
      mine.length,
      MAX_ITEMS_PER_ACTION,
      MAX_ITEMS_PER_PACK - items.length
    );
    truncated[action] = mine.length - take;
    items.push(...mine.slice(0, take));
  }
  return { items, truncated };
}

/** PURE: the pack title, one shared-vocabulary clause per non-empty group. */
export function buildCleanupPackSummary(
  items: readonly CleanupPackItemV2[]
): string {
  const clauses = CLEANUP_PACK_ACTIONS.map(
    (action) =>
      [action, items.filter((i) => i.action === action).length] as const
  )
    .filter(([, n]) => n > 0)
    .map(([action, n], i) => {
      const clause = describeCleanupAction(action, n);
      return i === 0
        ? clause
        : clause.charAt(0).toLowerCase() + clause.slice(1);
    });
  return `Tidy your pod: ${clauses.join(", ")}`;
}

/** A stored pack row, as the don't-nag rule and the supersede read it. */
export interface PackRow {
  status: string;
  createdAt: Date;
  reviewedAt: Date | null;
  data: unknown;
}

export type SuppressionReason = "open" | "kept" | "refused" | "rejectedPack";

/** PURE: an undecided pack this old is superseded instead of left to block. */
export function isSupersedable(row: PackRow, now: Date): boolean {
  return (
    row.status === ProposalStatus.PENDING &&
    row.createdAt.getTime() < now.getTime() - SUPERSEDE_AFTER_DAYS * DAY_MS
  );
}

/**
 * PURE — THE don't-nag RULE: which item refs must not be proposed again, and why.
 *
 *   open          named in a pending pack that is not yet supersedable
 *   rejectedPack  in a pack REJECTED whole within REJECTED_PACK_SILENCE_DAYS
 *   kept          left out (`dispositions[ref].status === "reject"`) in a pack
 *                 decided within KEEP_DAYS for the item's subject kind
 *   refused       refused at apply in a pack decided within REFUSED_SETTLE_DAYS
 *
 * "Decided" is a STATUS (approved / rejected) with `reviewedAt` inside the
 * window — never `reviewedAt` alone, because the proposer withdraw door stamps
 * it too. Expired and withdrawn packs buy no silence: an expiry is not a
 * decision. v1 packs carry positional refs that name no object, so they buy
 * none either.
 *
 * The SQL read that feeds this only bounds the rows. This function is the rule,
 * so deleting any arm of it is visible to a test (the warden's lesson: a guard
 * living only in a WHERE clause is invisible to every mocked query).
 */
export function suppressedRefs(
  rows: readonly PackRow[],
  now: Date
): Map<string, SuppressionReason> {
  const out = new Map<string, SuppressionReason>();
  const mark = (ref: string, reason: SuppressionReason) => {
    if (!out.has(ref)) out.set(ref, reason);
  };
  const within = (at: Date | null, days: number) =>
    at instanceof Date && at.getTime() >= now.getTime() - days * DAY_MS;

  for (const row of rows) {
    const items = readPackItems(row.data).items.filter((i) => !i.legacy);
    if (items.length === 0) continue;

    if (row.status === ProposalStatus.PENDING) {
      if (isSupersedable(row, now)) continue;
      for (const i of items) mark(i.ref, "open");
      continue;
    }

    const decided =
      row.status === ProposalStatus.APPROVED ||
      row.status === ProposalStatus.REJECTED;
    if (!decided) continue;

    const data = (row.data ?? {}) as {
      dispositions?: Record<string, { status?: string } | undefined>;
      outcomes?: unknown;
    };
    const outcomes =
      data.outcomes &&
      typeof data.outcomes === "object" &&
      !Array.isArray(data.outcomes)
        ? (data.outcomes as Record<string, { outcome?: string } | undefined>)
        : undefined;
    for (const i of items) {
      if (
        row.status === ProposalStatus.REJECTED &&
        within(row.reviewedAt, REJECTED_PACK_SILENCE_DAYS)
      ) {
        mark(i.ref, "rejectedPack");
        continue;
      }
      const keepDays =
        KEEP_DAYS[CLEANUP_ACTION_SUBJECT_KIND[i.action as CleanupPackAction]];
      if (
        data.dispositions?.[i.ref]?.status === "reject" &&
        within(row.reviewedAt, keepDays)
      ) {
        mark(i.ref, "kept");
        continue;
      }
      if (
        outcomes?.[i.ref]?.outcome === "refused" &&
        within(row.reviewedAt, REFUSED_SETTLE_DAYS)
      ) {
        mark(i.ref, "refused");
      }
    }
  }
  return out;
}

// ── DB tier ──────────────────────────────────────────────────────────────────

export function cutoffIso(now: Date, days: number): string {
  // postgres.js: never bind a Date — bind the ISO string.
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

interface StoredPack extends PackRow {
  id: string;
  ownerUserId: string;
}

/** Every pack the don't-nag rule or the supersede can act on — SQL-bounded only. */
async function loadPackRows(now: Date): Promise<StoredPack[]> {
  const widest = Math.max(
    KEEP_DAYS.kind,
    KEEP_DAYS.session,
    REFUSED_SETTLE_DAYS,
    REJECTED_PACK_SILENCE_DAYS
  );
  const rows = await db
    .select({
      id: proposals.id,
      status: proposals.status,
      createdAt: proposals.createdAt,
      reviewedAt: proposals.reviewedAt,
      data: proposals.data,
      subjectUserId: proposals.subjectUserId,
      targetId: proposals.targetId,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "pod_hygiene"),
        eq(proposals.proposalType, "cleanup_pack"),
        or(
          eq(proposals.status, ProposalStatus.PENDING),
          and(
            inArray(proposals.status, [
              ProposalStatus.APPROVED,
              ProposalStatus.REJECTED,
            ]),
            gte(
              proposals.reviewedAt,
              drizzleSql`${cutoffIso(now, widest)}::timestamptz`
            )
          )
        )
      )
    );
  return rows.map((r) => ({
    id: r.id,
    ownerUserId: r.subjectUserId ?? r.targetId,
    status: r.status,
    createdAt: new Date(r.createdAt),
    reviewedAt: r.reviewedAt ? new Date(r.reviewedAt) : null,
    data: r.data,
  }));
}

/** A zero-entity kind before its retire preflight has run. */
interface KindCandidate {
  profileId: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface GatheredCandidates {
  sessions: CleanupCandidate[];
  kinds: KindCandidate[];
  /** Found but not packable: no single human owner. */
  unowned: { sharedKinds: number };
}

export async function gatherCleanupCandidates(
  now: Date
): Promise<GatheredCandidates> {
  const sessions: CleanupCandidate[] = [];
  const kinds: KindCandidate[] = [];
  const unowned = { sharedKinds: 0 };

  const sessionRows = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      title: focusSessions.title,
      goal: focusSessions.goal,
      createdAt: focusSessions.createdAt,
      updatedAt: focusSessions.updatedAt,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.status, "stale"),
        lt(
          focusSessions.updatedAt,
          drizzleSql`${cutoffIso(now, STALE_SESSION_DAYS)}::timestamptz`
        ),
        sessionKindWhere("work")
      )
    );
  for (const s of sessionRows) {
    sessions.push({
      ownerUserId: s.userId,
      item: {
        ref: stableItemRef("close_session", s.id),
        action: "close_session",
        subject: {
          kind: CLEANUP_ACTION_SUBJECT_KIND.close_session,
          id: s.id,
          name: s.title ?? s.goal.split("\n")[0]!.slice(0, 120),
        },
        evidence: {
          createdAt: iso(s.createdAt ?? s.updatedAt),
          lastActivityAt: iso(s.updatedAt),
        },
        reversible: CLEANUP_ACTION_REVERSIBLE.close_session,
        risk: "low",
        // Apply-time re-validation: the session must still be idle SINCE this.
        snapshot: { updatedAt: iso(s.updatedAt) },
      },
    });
  }

  const kindRows = await db
    .select({
      id: profiles.id,
      slug: profiles.slug,
      displayName: profiles.displayName,
      scope: profiles.scope,
      userId: profiles.userId,
      workspaceId: profiles.workspaceId,
      ownerId: workspaces.ownerId,
      createdAt: profiles.createdAt,
      updatedAt: profiles.updatedAt,
    })
    .from(profiles)
    .leftJoin(workspaces, eq(workspaces.id, profiles.workspaceId))
    .where(
      and(
        eq(profiles.isActive, true),
        ne(profiles.scope, ProfileScope.SYSTEM),
        eq(profiles.profileKind, "kind"),
        lt(
          profiles.createdAt,
          drizzleSql`${cutoffIso(now, KIND_MIN_AGE_DAYS)}::timestamptz`
        ),
        drizzleSql`NOT EXISTS (SELECT 1 FROM ${entities} e WHERE e.profile_id = ${profiles.id} AND e.deleted_at IS NULL)`
      )
    );
  const alreadyRetiring = await profilesWithPendingRetire(
    kindRows.map((k) => k.id)
  );
  for (const k of kindRows) {
    if (alreadyRetiring.has(k.id)) continue;
    const owner = k.workspaceId
      ? k.ownerId
      : k.scope === "user"
        ? k.userId
        : null;
    if (!owner) {
      unowned.sharedKinds += 1;
      continue;
    }
    kinds.push({
      profileId: k.id,
      name: k.displayName,
      ownerUserId: owner,
      createdAt: iso(k.createdAt),
      updatedAt: iso(k.updatedAt),
    });
  }

  // Agent principals never own a pack — an agent cannot approve one anyway
  // (the review ladder's agent-class floor), so a pack for it is a dead row.
  const ownerIds = [
    ...new Set([
      ...sessions.map((c) => c.ownerUserId),
      ...kinds.map((k) => k.ownerUserId),
    ]),
  ];
  const agentIds =
    ownerIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ id: users.id })
              .from(users)
              .where(
                and(inArray(users.id, ownerIds), eq(users.userType, "agent"))
              )
          ).map((u) => u.id)
        );

  const byHuman = <T extends { ownerUserId: string }>(list: T[]) =>
    list.filter((c) => !agentIds.has(c.ownerUserId));
  return { sessions: byHuman(sessions), kinds: byHuman(kinds), unowned };
}

/**
 * Run the retire preflight for a kind and build its item from the evidence.
 * `null` when the preflight would refuse — that kind is counted, never packed.
 */
async function preflightKindItem(
  k: KindCandidate
): Promise<CleanupPackItemV2 | null> {
  const inspection = await inspectProfileRetirement(k.profileId);
  if (!inspection || inspection.decision.verdict !== "retirable") return null;
  const d = inspection.dependents;
  return {
    ref: stableItemRef("retire_profile", k.profileId),
    action: "retire_profile",
    subject: {
      kind: CLEANUP_ACTION_SUBJECT_KIND.retire_profile,
      id: k.profileId,
      name: k.name,
    },
    evidence: {
      createdAt: k.createdAt,
      lastActivityAt: null,
      records: d.entities,
      dependents: {
        views: d.views,
        automations: d.automations,
        relationTypes: d.profileRelations,
        facets: d.liveFacets,
      },
    },
    reversible: CLEANUP_ACTION_REVERSIBLE.retire_profile,
    risk: "low",
    snapshot: { updatedAt: k.updatedAt },
  };
}

/**
 * Withdraw an undecided pack the filer is replacing. `withdrawn` is "retracted by
 * its own proposer" — here the filer recalling its own stale ask. `reviewedAt`
 * is deliberately NOT set: a supersede is not a decision and buys no silence.
 * PENDING is re-asserted, so a pack the owner decided meanwhile is never touched.
 */
async function supersedePack(
  id: string,
  supersededBy: string | null,
  now: Date
): Promise<boolean> {
  const reason = supersededBy
    ? "Superseded by a fresher cleanup pack."
    : "Nothing in it is left to tidy.";
  const rows = await db
    .update(proposals)
    .set({
      status: ProposalStatus.WITHDRAWN,
      updatedAt: now,
      data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || jsonb_build_object('supersededBy', ${supersededBy}::text, 'withdrawReason', ${reason}::text)`,
    })
    .where(
      and(eq(proposals.id, id), eq(proposals.status, ProposalStatus.PENDING))
    )
    .returning({ id: proposals.id, data: proposals.data });
  if (rows.length === 0) return false;
  markProposalNotificationsActioned([id]);
  // WITHDRAWN is terminal: the same discard every terminal door makes. A no-op
  // for a pack (it stages no source blob); `null` because, like the expiry
  // scanners, the filer acts as no user.
  await discardProposalSourceBlob({
    database: db,
    userId: null,
    proposalData: rows[0]!.data,
  });
  return true;
}

export interface FileCleanupPacksResult {
  owners: number;
  filed: number;
  superseded: number;
  suppressed: Record<SuppressionReason, number>;
  capped: number;
  unowned: { sharedKinds: number };
  notPacked: { refusedByPreflight: number };
}

/**
 * The scanner. Per owner: files ONE pack of the items no rule suppresses, and
 * withdraws that owner's supersedable packs in favour of it. At most
 * MAX_PACKS_PER_RUN owners per run. NEVER applies anything.
 */
export async function fileCleanupPacks(
  now: Date = new Date()
): Promise<FileCleanupPacksResult> {
  const packRows = await loadPackRows(now);
  const suppressed = suppressedRefs(packRows, now);
  const { sessions, kinds, unowned } = await gatherCleanupCandidates(now);

  const suppressedCounts: Record<SuppressionReason, number> = {
    open: 0,
    kept: 0,
    refused: 0,
    rejectedPack: 0,
  };
  const isFree = (ref: string): boolean => {
    const why = suppressed.get(ref);
    if (why) suppressedCounts[why] += 1;
    return !why;
  };
  const pushTo = <T>(map: Map<string, T[]>, owner: string, value: T) => {
    const list = map.get(owner) ?? [];
    list.push(value);
    map.set(owner, list);
  };

  const sessionsByOwner = new Map<string, CleanupCandidate[]>();
  for (const c of sessions) {
    if (isFree(c.item.ref)) pushTo(sessionsByOwner, c.ownerUserId, c);
  }
  const kindsByOwner = new Map<string, KindCandidate[]>();
  for (const k of kinds) {
    if (isFree(stableItemRef("retire_profile", k.profileId))) {
      pushTo(kindsByOwner, k.ownerUserId, k);
    }
  }
  const stalePacksByOwner = new Map<string, StoredPack[]>();
  for (const row of packRows) {
    if (isSupersedable(row, now))
      pushTo(stalePacksByOwner, row.ownerUserId, row);
  }

  const owners = [
    ...new Set([
      ...sessionsByOwner.keys(),
      ...kindsByOwner.keys(),
      ...stalePacksByOwner.keys(),
    ]),
  ].sort();

  let filed = 0;
  let superseded = 0;
  let refusedByPreflight = 0;
  for (const ownerUserId of owners.slice(0, MAX_PACKS_PER_RUN)) {
    const candidates: CleanupCandidate[] = [
      ...(sessionsByOwner.get(ownerUserId) ?? []),
    ];
    // Kinds: preflight oldest first until the action cap is full. A kind the
    // retire preflight would refuse is counted and never packed.
    const ownerKinds = (kindsByOwner.get(ownerUserId) ?? []).sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    );
    let packedKinds = 0;
    let checked = 0;
    for (const k of ownerKinds) {
      if (packedKinds >= MAX_ITEMS_PER_ACTION) break;
      checked += 1;
      const item = await preflightKindItem(k);
      if (!item) {
        refusedByPreflight += 1;
        continue;
      }
      candidates.push({ item, ownerUserId });
      packedKinds += 1;
    }
    const { items, truncated } = buildCleanupPackItems(candidates);
    truncated.retire_profile += ownerKinds.length - checked;

    let newPackId: string | null = null;
    if (items.length > 0) {
      const data: CleanupPackData = {
        schema: CLEANUP_PACK_SCHEMA,
        sourceId: ownerUserId,
        summary: buildCleanupPackSummary(items),
        reasoning: PACK_REASONING,
        items,
        truncated,
        thresholds: {
          staleSessionDays: STALE_SESSION_DAYS,
          kindMinAgeDays: KIND_MIN_AGE_DAYS,
          keepDays: KEEP_DAYS,
          refusedSettleDays: REFUSED_SETTLE_DAYS,
          rejectedPackSilenceDays: REJECTED_PACK_SILENCE_DAYS,
          supersedeAfterDays: SUPERSEDE_AFTER_DAYS,
        },
        generatedAt: now.toISOString(),
      };
      try {
        const { proposal } = await insertPendingProposal({
          workspaceId: null,
          targetType: "pod_hygiene",
          targetId: ownerUserId,
          proposalType: "cleanup_pack",
          data: data as unknown as Record<string, unknown>,
          createdBy: ownerUserId,
          proposedByUserId: null,
          // OWNER FLOOR (0248): the owner IS the subject of their own pack.
          subjectUserId: ownerUserId,
        });
        newPackId = proposal.id;
        void emitSideEffects({
          subjectType: "proposal",
          action: "created",
          subjectId: proposal.id,
          userId: ownerUserId,
          data: { proposalStatus: "created", targetType: "pod_hygiene" },
        }).catch((err) => {
          logger.warn(
            { err, proposalId: proposal.id },
            "cleanup-pack: emitSideEffects failed (non-fatal)"
          );
        });
        filed += 1;
      } catch (err) {
        logger.error(
          { err, ownerUserId },
          "cleanup-pack: failed to file pack, skipping"
        );
        // Keep the old pack: the owner must never be left with nothing to decide.
        continue;
      }
    }

    for (const stale of stalePacksByOwner.get(ownerUserId) ?? []) {
      if (await supersedePack(stale.id, newPackId, now)) superseded += 1;
    }
  }

  return {
    owners: owners.length,
    filed,
    superseded,
    suppressed: suppressedCounts,
    capped: Math.max(0, owners.length - MAX_PACKS_PER_RUN),
    unowned,
    notPacked: { refusedByPreflight },
  };
}
