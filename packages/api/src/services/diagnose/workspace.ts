/**
 * WORKSPACE diagnosis — "is this workspace a real lens?" and, at class
 * altitude, "do I have too many workspaces?".
 *
 * WHY THIS EXISTS: `diagnose` covered nine object kinds and not the one the pod
 * is ORGANISED BY. A reviewer asking "do these two workspaces overlap, and by
 * how much?" had no door at all — the question was answerable only by raw SQL
 * against the pod's Postgres. That is the gap this closes; the shapes are the
 * existing `ObjectReport` / `ClassReport`, not a new envelope.
 *
 * ── WHAT IS REUSED, AND WHAT COULD NOT BE ───────────────────────────────────
 *  • FLOOR: `userVisibleWhere(workspaces.id, userId)` — the canonical
 *    three-branch workspace floor (member ∪ owner ∪ pod-visible). Not
 *    `getUserWorkspaceIds`, which is member ∪ pod-visible only and would hide a
 *    sovereign owner's own workspaces; not a hand-rolled predicate.
 *    `entities` is an ownerPrivate table (a NULL workspace means "personal to
 *    the owner"), so its aggregate is floored with `ownerPrivateVisibleWhere` —
 *    plain `userVisibleWhere` there admits every NULL-workspace row to every
 *    user.
 *  • `services/template-health.ts` answers a DIFFERENT question ("is this
 *    workspace behind its TEMPLATE?" — a version-stamp comparison). It is not
 *    workspace-content health and nothing in it is re-derived or duplicated
 *    here; `listWorkspaceTemplateHealth` stays the one door for drift.
 *  • `services/discover/discover.ts` computes a per-workspace entity count with
 *    the same `GROUP BY` shape, but it is INLINE in `discover()` (no exported
 *    helper) and, critically, it only counts `workspace_id IN (lens)` — it never
 *    sees the pod-scoped (`workspace_id IS NULL`) bucket, which is the half that
 *    makes "this workspace is barely a lens" visible. Its profile inventory
 *    comes from `profiles.listProfiles` (the SCHEMA available in a workspace),
 *    not from what actually LIVES there; on the live pod that call returns an
 *    empty list per workspace at this door. So the aggregate below is net-new:
 *    ONE `GROUP BY (workspace_id, type)` that yields entity counts, the
 *    profile-slug inventory, the last-activity timestamp and the pod-scoped
 *    bucket in a single pass.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 * Two queries total, regardless of workspace count: one workspace read, one
 * entity aggregate. Pairwise overlap is O(n²) but computed IN MEMORY over the
 * already-fetched slug sets — never a query per pair. n is bounded by
 * `MAX_PAIRWISE_WORKSPACES`; past that the pairing is skipped and the summary
 * SAYS so rather than shipping a quadratic scan.
 */

import {
  db,
  and,
  or,
  eq,
  inArray,
  isNull,
  drizzleSql,
  entities,
  workspaces,
} from "@synap/database";
import {
  userVisibleWhere,
  ownerPrivateVisibleWhere,
} from "../../utils/user-visible-where.js";
import type { ClassReport, ObjectReport } from "./types.js";

/** Beyond this many workspaces the in-memory pairwise pass is skipped. */
export const MAX_PAIRWISE_WORKSPACES = 60;
/** Pairs reported in `detail.overlaps` (ranked; the rest are counted only). */
const MAX_REPORTED_PAIRS = 20;
/** Jaccard at or above this reads as "these two are the same lens twice". */
export const NEAR_DUPLICATE_JACCARD = 0.5;

/**
 * A machine-generated stand-in for a description, not authored identity.
 * `orient` against the live pod returns `description: "Domain: builder"` for
 * nine of ten workspaces; the current source no longer renders that fallback
 * (see the comment in `discover.ts`), so the value is either persisted or still
 * produced by the deployed build. Either way, counting it as an authored
 * description would report identity that nobody wrote — which is the exact
 * blind spot this surface exists to expose.
 */
const PLACEHOLDER_DESCRIPTION = /^\s*domain:\s*\S+\s*$/i;

/** One workspace as the landscape sees it. Pure data — no DB types leak out. */
export interface WorkspaceLandscapeRow {
  id: string;
  name: string;
  domain: string | null;
  workspaceType: string | null;
  /** Authored description ONLY — never the `Domain: <x>` placeholder. */
  description: string | null;
  /** A template install's onboarding spec goal, when one is present. */
  onboardingGoal: string | null;
  hasOnboarding: boolean;
  /** Entities whose `workspace_id` IS this workspace. */
  entityCount: number;
  /** Distinct `entities.type` (profile slug) values living in this workspace. */
  profileSlugs: string[];
  /** Newest `entities.updated_at` in this workspace; null when empty. */
  lastActivityAt: string | null;
  archived: boolean;
}

/** The pod-scoped bucket — entities visible in EVERY workspace. */
export interface PodScopedBucket {
  entityCount: number;
  profileSlugs: string[];
}

/** One unordered workspace pair and how much vocabulary they share. */
export interface WorkspaceOverlapPair {
  aId: string;
  aName: string;
  bId: string;
  bName: string;
  shared: string[];
  sharedCount: number;
  /** |A∩B| / |A∪B| over profile slugs. 0 when both sides are empty. */
  jaccard: number;
}

// ── PURE tier ────────────────────────────────────────────────────────────────

/**
 * PURE: every unordered pair with a non-empty profile-slug intersection,
 * ranked by shared count then jaccard. In-memory over already-fetched sets —
 * this is the "zero intersection across 5 kinds vs 27" read, computed rather
 * than done by hand against raw SQL.
 */
export function computeWorkspaceOverlap(
  rows: WorkspaceLandscapeRow[]
): WorkspaceOverlapPair[] {
  const pairs: WorkspaceOverlapPair[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      const bSet = new Set(b.profileSlugs);
      const shared = a.profileSlugs.filter((s) => bSet.has(s)).sort();
      if (shared.length === 0) continue;
      const union = new Set([...a.profileSlugs, ...b.profileSlugs]).size;
      pairs.push({
        aId: a.id,
        aName: a.name,
        bId: b.id,
        bName: b.name,
        shared,
        sharedCount: shared.length,
        jaccard: union === 0 ? 0 : Number((shared.length / union).toFixed(4)),
      });
    }
  }
  return pairs.sort(
    (x, y) => y.sharedCount - x.sharedCount || y.jaccard - x.jaccard
  );
}

/** PURE: names held by more than one workspace (ambiguous by-name focus). */
export function duplicateWorkspaceNames(
  rows: WorkspaceLandscapeRow[]
): Array<{ name: string; ids: string[] }> {
  const byName = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(r.id);
  }
  return [...byName.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({
      name: rows.find((r) => r.name.trim().toLowerCase() === key)!.name,
      ids,
    }));
}

/**
 * PURE: rank the landscape into a plain-language `ClassReport`. Honest-empty in
 * the same voice as `summarizeGlobalHealth` — when nothing is wrong it SAYS so
 * instead of returning a bare shape. `pairsSkipped` is true when the workspace
 * count exceeded `MAX_PAIRWISE_WORKSPACES`; the summary then names the omission
 * rather than implying "no overlap".
 */
export function summarizeWorkspaceLandscape(params: {
  rows: WorkspaceLandscapeRow[];
  podScoped: PodScopedBucket;
  overlaps: WorkspaceOverlapPair[];
  pairsSkipped: boolean;
  scopedToOne: boolean;
}): ClassReport {
  const { rows, podScoped, overlaps, pairsSkipped, scopedToOne } = params;

  const empty = rows.filter((r) => r.entityCount === 0);
  const unauthored = rows.filter((r) => !r.description && !r.hasOnboarding);
  const duplicateNames = duplicateWorkspaceNames(rows);
  const nearDuplicates = overlaps.filter(
    (p) => p.jaccard >= NEAR_DUPLICATE_JACCARD
  );

  const problems: string[] = [];
  if (empty.length > 0)
    problems.push(
      `${empty.length} hold no entities (${empty.map((r) => r.name).join(", ")})`
    );
  if (duplicateNames.length > 0)
    problems.push(
      `${duplicateNames.length} name(s) are used twice (${duplicateNames
        .map((d) => d.name)
        .join(", ")}) — focusing by name is ambiguous`
    );
  if (nearDuplicates.length > 0)
    problems.push(
      `${nearDuplicates.length} pair(s) overlap by half their kinds or more`
    );
  if (unauthored.length > 0)
    problems.push(
      `${unauthored.length} have no authored description or onboarding spec`
    );
  if (podScoped.entityCount > 0)
    problems.push(
      `${podScoped.entityCount} entity(ies) are pod-scoped and therefore visible in EVERY workspace`
    );

  const head = scopedToOne
    ? `1 workspace in this lens.`
    : `${rows.length} workspace(s).`;
  const overlapLine = pairsSkipped
    ? ` Pairwise overlap not computed (more than ${MAX_PAIRWISE_WORKSPACES} workspaces).`
    : overlaps.length === 0
      ? ` No two share a single entity kind — the lenses are disjoint.`
      : ` ${overlaps.length} pair(s) share at least one entity kind; the largest is ${overlaps[0]!.aName} ∩ ${overlaps[0]!.bName} (${overlaps[0]!.sharedCount} kind(s)).`;

  const summary =
    problems.length === 0
      ? `${head}${overlapLine} All carry entities and an authored identity — nothing suggests consolidation.`
      : `${head}${overlapLine} ${problems.length} thing(s) to look at: ${problems.join("; ")}.`;

  return {
    mode: "class",
    type: "workspace",
    summary,
    detail: {
      total: rows.length,
      workspaces: rows,
      podScoped,
      overlaps: overlaps.slice(0, MAX_REPORTED_PAIRS),
      overlapPairsTotal: overlaps.length,
      overlapPairsSkipped: pairsSkipped,
      nearDuplicatePairs: nearDuplicates.slice(0, MAX_REPORTED_PAIRS),
      emptyWorkspaces: empty.map((r) => ({ id: r.id, name: r.name })),
      duplicateNames,
      withoutAuthoredIdentity: unauthored.map((r) => ({
        id: r.id,
        name: r.name,
      })),
    },
  };
}

/**
 * PURE: one workspace as an `ObjectReport`. `podScoped` is the pod-wide bucket
 * — entities with a NULL workspace are visible HERE too, so a workspace whose
 * visible content is mostly pod-scoped is barely a lens at all, and that share
 * is the state field that says it.
 */
export function summarizeWorkspaceObject(params: {
  row: WorkspaceLandscapeRow;
  siblings: WorkspaceLandscapeRow[];
  podScoped: PodScopedBucket;
  overlaps: WorkspaceOverlapPair[];
}): ObjectReport {
  const { row, siblings, podScoped, overlaps } = params;
  const visibleTotal = row.entityCount + podScoped.entityCount;
  const podScopedShare =
    visibleTotal === 0
      ? 0
      : Number((podScoped.entityCount / visibleTotal).toFixed(4));
  const duplicateNamesakes = siblings
    .filter(
      (s) =>
        s.id !== row.id &&
        s.name.trim().toLowerCase() === row.name.trim().toLowerCase()
    )
    .map((s) => s.id);
  const mine = overlaps.filter((p) => p.aId === row.id || p.bId === row.id);

  const notes: string[] = [];
  if (row.entityCount === 0) notes.push("holds no entities of its own");
  if (duplicateNamesakes.length > 0)
    notes.push(
      `shares its name with ${duplicateNamesakes.length} other workspace(s)`
    );
  if (!row.description && !row.hasOnboarding)
    notes.push("has no authored description or onboarding spec");
  if (podScopedShare >= 0.5 && podScoped.entityCount > 0)
    notes.push(
      `${Math.round(podScopedShare * 100)}% of what is visible here is pod-scoped (visible in every workspace)`
    );

  return {
    mode: "object",
    kind: "workspace",
    id: row.id,
    summary:
      `Workspace "${row.name}" (${row.domain ?? row.workspaceType ?? "no domain"}) holds ${row.entityCount} entity(ies) across ${row.profileSlugs.length} kind(s)` +
      (notes.length > 0 ? ` — ${notes.join("; ")}.` : "."),
    state: {
      name: row.name,
      domain: row.domain,
      workspaceType: row.workspaceType,
      description: row.description,
      onboardingGoal: row.onboardingGoal,
      hasOnboarding: row.hasOnboarding,
      archived: row.archived,
      entityCount: row.entityCount,
      profileSlugs: row.profileSlugs,
      lastActivityAt: row.lastActivityAt,
      podScoped: {
        entityCount: podScoped.entityCount,
        /** Pod-scoped entities / everything visible in this workspace. */
        shareOfVisible: podScopedShare,
      },
    },
    why: {
      isEmpty: row.entityCount === 0,
      duplicateNameWith: duplicateNamesakes,
      hasAuthoredIdentity: Boolean(row.description || row.hasOnboarding),
      overlapsWith: mine.slice(0, MAX_REPORTED_PAIRS).map((p) => ({
        workspaceId: p.aId === row.id ? p.bId : p.aId,
        name: p.aId === row.id ? p.bName : p.aName,
        shared: p.shared,
        jaccard: p.jaccard,
      })),
    },
  };
}

// ── DB tier ──────────────────────────────────────────────────────────────────

interface Landscape {
  rows: WorkspaceLandscapeRow[];
  podScoped: PodScopedBucket;
}

/**
 * Load every workspace the caller can see plus the entity aggregate, in TWO
 * queries. `lensIds` narrows the ENTITY aggregate only (object mode) — the
 * workspace list is always the full floored set, because duplicate-name
 * detection is a property of the set, not of one row.
 */
async function loadLandscape(
  userId: string,
  entityLensIds?: string[]
): Promise<Landscape> {
  const wsRows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      description: workspaces.description,
      domain: workspaces.domain,
      workspaceType: workspaces.workspaceType,
      settings: workspaces.settings,
      archivedAt: workspaces.archivedAt,
    })
    .from(workspaces)
    .where(userVisibleWhere(workspaces.id, userId));

  const aggIds = entityLensIds ?? wsRows.map((w) => w.id);
  // ONE pass: per (workspace, profile slug) count + newest activity. The
  // `workspace_id IS NULL` branch is deliberately inside the same scan — that
  // bucket is the pod-scoped content visible in every workspace, and it is the
  // half `discover`'s count never sees.
  const agg = await db
    .select({
      workspaceId: entities.workspaceId,
      type: entities.type,
      count: drizzleSql<number>`cast(count(*) as integer)`,
      lastActivityAt: drizzleSql<Date | null>`max(${entities.updatedAt})`,
    })
    .from(entities)
    .where(
      and(
        isNull(entities.deletedAt),
        ownerPrivateVisibleWhere(entities.workspaceId, entities.userId, userId),
        aggIds.length > 0
          ? or(
              isNull(entities.workspaceId),
              inArray(entities.workspaceId, aggIds)
            )
          : isNull(entities.workspaceId)
      )
    )
    .groupBy(entities.workspaceId, entities.type);

  const byWs = new Map<
    string,
    { count: number; slugs: Set<string>; last: Date | null }
  >();
  const podSlugs = new Set<string>();
  let podCount = 0;
  for (const r of agg) {
    const last = r.lastActivityAt ? new Date(r.lastActivityAt) : null;
    if (r.workspaceId == null) {
      podCount += r.count;
      if (r.type) podSlugs.add(r.type);
      continue;
    }
    const bucket = byWs.get(r.workspaceId) ?? {
      count: 0,
      slugs: new Set<string>(),
      last: null,
    };
    bucket.count += r.count;
    if (r.type) bucket.slugs.add(r.type);
    if (last && (!bucket.last || last > bucket.last)) bucket.last = last;
    byWs.set(r.workspaceId, bucket);
  }

  const rows: WorkspaceLandscapeRow[] = wsRows.map((w) => {
    const bucket = byWs.get(w.id);
    const settings = (w.settings ?? {}) as Record<string, unknown>;
    const onboarding = settings.onboarding as { goal?: unknown } | undefined;
    const desc =
      typeof w.description === "string" && w.description.trim()
        ? w.description.trim()
        : null;
    return {
      id: w.id,
      name: w.name,
      domain: w.domain ?? null,
      workspaceType: w.workspaceType ?? null,
      description: desc && !PLACEHOLDER_DESCRIPTION.test(desc) ? desc : null,
      onboardingGoal:
        typeof onboarding?.goal === "string" ? onboarding.goal : null,
      hasOnboarding: Boolean(onboarding),
      entityCount: bucket?.count ?? 0,
      profileSlugs: [...(bucket?.slugs ?? [])].sort(),
      lastActivityAt: bucket?.last ? bucket.last.toISOString() : null,
      archived: w.archivedAt != null,
    };
  });

  return {
    rows,
    podScoped: { entityCount: podCount, profileSlugs: [...podSlugs].sort() },
  };
}

/**
 * CLASS mode — the whole workspace landscape plus the pairwise overlap read
 * that makes "you have too many workspaces" an evidenced statement instead of a
 * feeling. `workspaceId` narrows to one lens (the landscape then reports that
 * single row, and no pair has two sides).
 */
export async function diagnoseWorkspaceClass(
  userId: string,
  workspaceId?: string
): Promise<ClassReport> {
  const { rows, podScoped } = await loadLandscape(userId);
  const scoped = workspaceId ? rows.filter((r) => r.id === workspaceId) : rows;
  const pairsSkipped = scoped.length > MAX_PAIRWISE_WORKSPACES;
  const overlaps = pairsSkipped ? [] : computeWorkspaceOverlap(scoped);
  return summarizeWorkspaceLandscape({
    rows: scoped,
    podScoped,
    overlaps,
    pairsSkipped,
    scopedToOne: Boolean(workspaceId),
  });
}

/** OBJECT mode — one workspace, with its overlap against its siblings. */
export async function diagnoseWorkspaceObject(
  userId: string,
  id: string
): Promise<ObjectReport | { error: string }> {
  const { rows, podScoped } = await loadLandscape(userId);
  const row = rows.find((r) => r.id === id);
  if (!row) return { error: "Workspace not found" };
  const overlaps =
    rows.length > MAX_PAIRWISE_WORKSPACES ? [] : computeWorkspaceOverlap(rows);
  return summarizeWorkspaceObject({
    row,
    siblings: rows,
    podScoped,
    overlaps,
  });
}

/**
 * The workspace probe's own floor, exported so `resolve-object-kind.ts` and
 * this module can never disagree about which workspaces the caller may see.
 */
export function visibleWorkspaceWhere(id: string, userId: string) {
  return and(eq(workspaces.id, id), userVisibleWhere(workspaces.id, userId));
}
