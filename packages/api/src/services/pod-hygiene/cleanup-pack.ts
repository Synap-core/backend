/**
 * Pod hygiene CLEANUP PACK — the scanner half: a reviewable pack PROPOSED to the
 * human, never applied.
 *
 * Daily, per human owner, ONE pending `pod_hygiene/cleanup_pack` proposal that
 * lists:
 *   - `close_session`    work sessions the reaper already marked `stale`, with
 *                        no activity for STALE_SESSION_DAYS;
 *   - `expire_proposal`  pending `objectWork`-class proposals older than
 *                        OLD_PROPOSAL_DAYS (that class has no lifetime, so
 *                        nothing else ever retires them);
 *   - `retire_profile`   active, non-system kinds older than KIND_MIN_AGE_DAYS
 *                        with zero live entities pod-wide;
 *   - `pause_automation` active/draft automations older than
 *                        AUTOMATION_MIN_AGE_DAYS that have never run.
 *
 * Shape follows `jobs/workers/librarian-archiver.ts` (select → idempotency skip
 * → cap → `insertPendingProposal`), but it lives in @synap/api because two of
 * its rules are api-owned SSOTs that jobs cannot import: the session KIND
 * (`sessionKindWhere`) and the proposal CLASS (`classifyProposal`). The jobs
 * cron reaches it through the `registerCleanupPackRunner` IoC slot, exactly
 * like `stale-proposal-cron` reaches `expireLapsedProposals`.
 *
 * ── Why ONE pack with per-item reject, not N proposals in a session ──────────
 * The reviewer's unit of work is "tidy my pod", and the existing per-item
 * channel (`proposals.rejectItem` → `data.dispositions[itemRef]`) is generic
 * over any proposal's `data`, so a pack gets per-item decisions without a new
 * door. The composite plan machinery was NOT reused: its all-or-none
 * compensation exists to undo creates; a pack only retires, each item is
 * independent, and one refused item must not undo the others.
 *
 * Owner rule (who reviews an item): the session's `userId`; the proposal's
 * `subjectUserId`, else its human `createdBy` when no agent authored it; the
 * automation's `createdBy`; a workspace kind's workspace OWNER, a user-scoped
 * kind's `userId`. Shared kinds with no home workspace have no single human
 * owner and are NOT packed (counted in the result). Agent principals never
 * own a pack.
 */

import {
  db,
  and,
  eq,
  lt,
  ne,
  inArray,
  isNull,
  drizzleSql,
  focusSessions,
  proposals,
  profiles,
  entities,
  automations,
  workspaces,
  users,
  ProposalStatus,
  ProfileScope,
  insertPendingProposal,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  buildObjectActionTitle,
  resolveActionLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "@synap-core/types/vocabulary";
import { emitSideEffects } from "@synap/events";
import { sessionKindWhere } from "../focus-sessions/session-kind.js";
import { classifyProposal } from "../proposals/proposal-class.js";
import { profilesWithPendingRetire } from "./retire-profile.js";

const logger = createLogger({ module: "pod-hygiene-cleanup-pack" });

export const STALE_SESSION_DAYS = 30;
export const OLD_PROPOSAL_DAYS = 30;
export const KIND_MIN_AGE_DAYS = 30;
export const AUTOMATION_MIN_AGE_DAYS = 30;
/** Per action, per pack. The rest is counted in `truncated`, never dropped silently. */
export const MAX_ITEMS_PER_ACTION = 25;
/** Safety cap: packs filed in one run. */
export const MAX_PACKS_PER_RUN = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

export const CLEANUP_PACK_ACTIONS = [
  "close_session",
  "expire_proposal",
  "retire_profile",
  "pause_automation",
] as const;
export type CleanupPackAction = (typeof CLEANUP_PACK_ACTIONS)[number];

export interface CleanupPackItem {
  /** Stable per pack — the key `proposals.rejectItem` writes a disposition under. */
  ref: string;
  action: CleanupPackAction;
  targetId: string;
  label: string;
  reason: string;
}

export interface CleanupCandidate {
  action: CleanupPackAction;
  targetId: string;
  ownerUserId: string;
  label: string;
  /** Age anchor, used for ordering (oldest first) and the reason line. */
  since: Date;
}

export interface CleanupPackData {
  sourceId: string;
  /**
   * `update`, on purpose: the review renderers (desktop `ProposalKindBody`,
   * relay `[id].tsx`) show an update's `properties.*` rows. Without an explicit
   * changeType the card defaulted to update anyway, but with no rows — blank.
   */
  changeType: "update";
  summary: string;
  reasoning: string;
  /** Reviewer-facing rows: one per action group, naming every item. */
  properties: Record<string, string | number>;
  items: CleanupPackItem[];
  truncated: Record<CleanupPackAction, number>;
  thresholds: {
    staleSessionDays: number;
    oldProposalDays: number;
    kindMinAgeDays: number;
    automationMinAgeDays: number;
  };
  generatedAt: string;
}

// ── Pure ─────────────────────────────────────────────────────────────────────

function reasonFor(c: CleanupCandidate, now: Date): string {
  const days = Math.floor((now.getTime() - c.since.getTime()) / DAY_MS);
  switch (c.action) {
    case "close_session":
      return `No activity for ${days} days. Closing keeps its history; nothing is deleted.`;
    case "expire_proposal":
      return `Waiting for a decision for ${days} days. Expiring removes it from the queue without applying it.`;
    case "retire_profile":
      return `No records have used this kind in the ${days} days since it was created. Retiring hides it and can be undone; its dependencies are checked again when you approve.`;
    case "pause_automation":
      return `Created ${days} days ago and has never run. Pausing stops it from firing; it can be resumed.`;
  }
}

/**
 * PURE: one owner's candidates → the pack's items. Oldest first per action,
 * capped per action, refs assigned in a stable order.
 */
export function buildCleanupPackItems(
  candidates: readonly CleanupCandidate[],
  opts: { now: Date; maxPerAction?: number }
): { items: CleanupPackItem[]; truncated: Record<CleanupPackAction, number> } {
  const cap = opts.maxPerAction ?? MAX_ITEMS_PER_ACTION;
  const items: CleanupPackItem[] = [];
  const truncated = {} as Record<CleanupPackAction, number>;
  for (const action of CLEANUP_PACK_ACTIONS) {
    const mine = candidates
      .filter((c) => c.action === action)
      .sort((a, b) => a.since.getTime() - b.since.getTime());
    truncated[action] = Math.max(0, mine.length - cap);
    for (const c of mine.slice(0, cap)) {
      items.push({
        ref: `$item${items.length}`,
        action,
        targetId: c.targetId,
        label: c.label,
        reason: reasonFor(c, opts.now),
      });
    }
  }
  return { items, truncated };
}

/**
 * Per action: the vocabulary verb and noun tokens (resolved through the one
 * door), plus the product adjective, which is copy and stays local.
 */
const ACTION_PHRASE: Record<
  CleanupPackAction,
  { verb: string; noun: string; qualify: (noun: string) => string }
> = {
  close_session: {
    verb: "close",
    noun: "session",
    qualify: (n) => `idle ${n}`,
  },
  expire_proposal: {
    verb: "expire",
    noun: "proposal",
    qualify: (n) => `old ${n}`,
  },
  retire_profile: {
    verb: "retire",
    noun: "kind",
    qualify: (n) => `unused ${n}`,
  },
  pause_automation: {
    verb: "pause",
    noun: "automation",
    qualify: (n) => `${n} that never ran`,
  },
};

/** PURE: "Close 3 idle sessions" — verb and noun from the vocabulary door. */
export function describeCleanupAction(
  action: CleanupPackAction,
  count: number
): string {
  const phrase = ACTION_PHRASE[action];
  const noun = (
    count === 1
      ? resolveObjectNoun(phrase.noun)
      : resolveObjectNounPlural(phrase.noun)
  ).toLowerCase();
  return `${resolveActionLabel(phrase.verb, "imperative")} ${count} ${phrase.qualify(noun)}`;
}

/** PURE: the pack title, one clause per non-empty action group. */
export function buildCleanupPackSummary(
  counts: ReadonlyArray<readonly [CleanupPackAction, number]>
): string {
  return `Tidy your pod: ${counts
    .map(([action, n], i) => {
      const clause = describeCleanupAction(action, n);
      return i === 0
        ? clause
        : clause.charAt(0).toLowerCase() + clause.slice(1);
    })
    .join(", ")}`;
}

/**
 * PURE: the rows the review card renders — one per action group, listing its
 * items, plus what is left for a later pack and what one Approve does.
 */
export function buildCleanupPackRows(
  items: readonly CleanupPackItem[],
  truncated: Record<CleanupPackAction, number>
): Record<string, string | number> {
  const rows: Record<string, string | number> = {};
  for (const action of CLEANUP_PACK_ACTIONS) {
    const mine = items.filter((i) => i.action === action);
    if (mine.length === 0) continue;
    rows[describeCleanupAction(action, mine.length)] = mine
      .map((i) => i.label)
      .join("; ");
  }
  const later = CLEANUP_PACK_ACTIONS.reduce(
    (n, a) => n + (truncated[a] ?? 0),
    0
  );
  if (later > 0) rows["left for a later pack"] = later;
  rows["on approve"] =
    "Applies every item listed. Each is checked again first; anything that changed since is skipped and reported.";
  return rows;
}

/** PURE: group candidates by owner, dropping owners that already hold a pack. */
export function groupCandidatesByOwner(
  candidates: readonly CleanupCandidate[],
  ownersWithOpenPack: ReadonlySet<string>
): Map<string, CleanupCandidate[]> {
  const byOwner = new Map<string, CleanupCandidate[]>();
  for (const c of candidates) {
    if (ownersWithOpenPack.has(c.ownerUserId)) continue;
    const list = byOwner.get(c.ownerUserId) ?? [];
    list.push(c);
    byOwner.set(c.ownerUserId, list);
  }
  return byOwner;
}

/** PURE: the owner of a pending proposal — never an agent, never a guess. */
export function proposalOwner(row: {
  subjectUserId: string | null;
  createdBy: string | null;
  agentUserId: string | null;
}): string | null {
  if (row.subjectUserId) return row.subjectUserId;
  if (!row.agentUserId && row.createdBy) return row.createdBy;
  return null;
}

/** Proposal pairs the pack must never pack (its own lineage). */
const HYGIENE_PAIRS = new Set([
  "pod_hygiene/cleanup_pack",
  "profile/retire",
  "profile/merge",
]);

// ── DB tier ──────────────────────────────────────────────────────────────────

export function cutoffIso(now: Date, days: number): string {
  // postgres.js: never bind a Date — bind the ISO string.
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

export interface GatheredCandidates {
  candidates: CleanupCandidate[];
  /** Found but not packable: no single human owner. */
  unowned: { proposals: number; sharedKinds: number };
}

export async function gatherCleanupCandidates(
  now: Date
): Promise<GatheredCandidates> {
  const candidates: CleanupCandidate[] = [];
  const unowned = { proposals: 0, sharedKinds: 0 };

  const sessionRows = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      title: focusSessions.title,
      goal: focusSessions.goal,
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
    candidates.push({
      action: "close_session",
      targetId: s.id,
      ownerUserId: s.userId,
      label: s.title ?? s.goal.split("\n")[0]!.slice(0, 120),
      since: new Date(s.updatedAt),
    });
  }

  const proposalRows = await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      subjectUserId: proposals.subjectUserId,
      createdBy: proposals.createdBy,
      agentUserId: proposals.agentUserId,
      createdAt: proposals.createdAt,
      data: proposals.data,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.PENDING),
        lt(
          proposals.createdAt,
          drizzleSql`${cutoffIso(now, OLD_PROPOSAL_DAYS)}::timestamptz`
        )
      )
    );
  for (const p of proposalRows) {
    if (HYGIENE_PAIRS.has(`${p.targetType}/${p.proposalType}`)) continue;
    if (classifyProposal(p.proposalType, p.targetType) !== "objectWork")
      continue;
    const owner = proposalOwner(p);
    if (!owner) {
      unowned.proposals += 1;
      continue;
    }
    const data = (p.data ?? {}) as Record<string, unknown>;
    candidates.push({
      action: "expire_proposal",
      targetId: p.id,
      ownerUserId: owner,
      label:
        typeof data.summary === "string"
          ? data.summary.slice(0, 120)
          : buildObjectActionTitle({
              action: p.proposalType,
              objectKind: p.targetType,
            }),
      since: new Date(p.createdAt),
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
    candidates.push({
      action: "retire_profile",
      targetId: k.id,
      ownerUserId: owner,
      label: `${k.displayName} (${k.slug})`,
      since: new Date(k.createdAt),
    });
  }

  const automationRows = await db
    .select({
      id: automations.id,
      name: automations.name,
      createdBy: automations.createdBy,
      createdAt: automations.createdAt,
    })
    .from(automations)
    .where(
      and(
        inArray(automations.status, ["active", "draft"]),
        eq(automations.runCount, 0),
        isNull(automations.lastRunAt),
        lt(
          automations.createdAt,
          drizzleSql`${cutoffIso(now, AUTOMATION_MIN_AGE_DAYS)}::timestamptz`
        )
      )
    );
  for (const a of automationRows) {
    candidates.push({
      action: "pause_automation",
      targetId: a.id,
      ownerUserId: a.createdBy,
      label: a.name,
      since: new Date(a.createdAt),
    });
  }

  // Agent principals never own a pack — an agent cannot approve one anyway
  // (the review ladder's agent-class floor), so a pack for it is a dead row.
  const ownerIds = [...new Set(candidates.map((c) => c.ownerUserId))];
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

  return {
    candidates: candidates.filter((c) => !agentIds.has(c.ownerUserId)),
    unowned,
  };
}

export interface FileCleanupPacksResult {
  owners: number;
  filed: number;
  skippedOpenPack: number;
  capped: number;
  unowned: GatheredCandidates["unowned"];
}

/**
 * The scanner. Files at most ONE pending pack per owner (idempotent: an owner
 * with a pending pack is skipped until they decide it), at most
 * MAX_PACKS_PER_RUN per run. NEVER applies anything.
 */
export async function fileCleanupPacks(
  now: Date = new Date()
): Promise<FileCleanupPacksResult> {
  const { candidates, unowned } = await gatherCleanupCandidates(now);

  const openPacks = await db
    .select({
      subjectUserId: proposals.subjectUserId,
      targetId: proposals.targetId,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.targetType, "pod_hygiene"),
        eq(proposals.proposalType, "cleanup_pack"),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  const ownersWithOpenPack = new Set(
    openPacks.map((p) => p.subjectUserId ?? p.targetId)
  );
  const allOwners = new Set(candidates.map((c) => c.ownerUserId));
  const byOwner = groupCandidatesByOwner(candidates, ownersWithOpenPack);
  const owners = [...byOwner.keys()].sort();
  const toFile = owners.slice(0, MAX_PACKS_PER_RUN);

  let filed = 0;
  for (const ownerUserId of toFile) {
    const { items, truncated } = buildCleanupPackItems(
      byOwner.get(ownerUserId)!,
      {
        now,
      }
    );
    if (items.length === 0) continue;
    const counts = CLEANUP_PACK_ACTIONS.map(
      (a) => [a, items.filter((i) => i.action === a).length] as const
    ).filter(([, n]) => n > 0);
    const data: CleanupPackData = {
      sourceId: ownerUserId,
      changeType: "update",
      summary: buildCleanupPackSummary(counts),
      reasoning:
        "Found by the pod hygiene scan. Nothing is applied until you approve, and every item is checked again when you do.",
      properties: buildCleanupPackRows(items, truncated),
      items,
      truncated,
      thresholds: {
        staleSessionDays: STALE_SESSION_DAYS,
        oldProposalDays: OLD_PROPOSAL_DAYS,
        kindMinAgeDays: KIND_MIN_AGE_DAYS,
        automationMinAgeDays: AUTOMATION_MIN_AGE_DAYS,
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
      void emitSideEffects({
        subjectType: "proposal",
        action: "created",
        subjectId: proposal.id,
        userId: ownerUserId,
        data: {
          proposalStatus: "created",
          targetType: "pod_hygiene",
          changeType: "update",
        },
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
    }
  }

  return {
    owners: allOwners.size,
    filed,
    skippedOpenPack: [...allOwners].filter((o) => ownersWithOpenPack.has(o))
      .length,
    capped: Math.max(0, owners.length - MAX_PACKS_PER_RUN),
    unowned,
  };
}

/** Tolerant read of `data.items` (the stored pack JSON). */
export function readPackItems(data: unknown): CleanupPackItem[] {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (i): i is CleanupPackItem =>
      !!i &&
      typeof i === "object" &&
      typeof (i as CleanupPackItem).ref === "string" &&
      typeof (i as CleanupPackItem).targetId === "string" &&
      (CLEANUP_PACK_ACTIONS as readonly string[]).includes(
        (i as CleanupPackItem).action
      )
  );
}
