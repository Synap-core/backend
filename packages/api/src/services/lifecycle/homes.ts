/**
 * OBJECT-FIRST HOMES — the two reads behind Home / a project page / Work
 * ("Moving now"): `lifecycle.home` and `lifecycle.moving`.
 *
 *   readHome   — every space the caller can see, with WHAT IT PRODUCES (its
 *                intent) and, per produced kind, the pipeline in one line:
 *                the per-status columns, live / done-this-window / total,
 *                needs-you, being-worked and ONE headline thing.
 *   readMoving — the things that have live work on them (an open session
 *                whose subject is the thing, an in-flight worker targeting
 *                it, a scheduled prep), with that work under each.
 *
 * Nothing here is a second derivation:
 *   - a (space, kind) resolves through `resolveBoardLens` — the board that
 *     kind's door opens reads the same lifecycle, conditions and subject;
 *   - columns come from THE status grouping (`groupThingsByStatus`);
 *   - needs-you is `countNeedsYouByScope` — `signals.count`'s own read and
 *     count, read ONCE and narrowed per space / kind;
 *   - "being worked" is the board's workedBy predicate (`loadOpenWork`).
 *
 * The intent is the template's (`settings.intent`, projected on install); a
 * space with none gets one INFERRED at read time — never stored.
 *
 * Failures: a needs-you or being-worked sub-read that fails is `null`, never
 * 0 (and the headline skips the reason it could not read). A produced slug the
 * pod does not know, or one that declares no lifecycle, is a fact — that kind
 * is left out, the way `lifecycle.list` leaves out an undeclared one. Any
 * other failure throws.
 */
import { TRPCError } from "@trpc/server";
import {
  db,
  and,
  eq,
  inArray,
  isNull,
  drizzleSql,
  declaredLifecycleProfilesStatement,
} from "@synap/database";
import {
  entities,
  entityFacets,
  profiles,
  workspaces,
} from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import { createLogger } from "@synap-core/core";
import {
  isTerminalLifecycleCategory,
  UNCLASSIFIED_STATUS,
  type LifecycleCategory,
} from "@synap-core/types/lifecycle";
import {
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { getUserWorkspaceIds } from "../../utils/workspace-membership.js";
import { projectLensWhere } from "../../utils/project-scope.js";
import { resolveActorNames } from "../../utils/resolve-actor-names.js";
import { rosterReadFor } from "../../access/session-visibility.js";
import {
  countThingsByProfileAndStatus,
  groupThingsByStatus,
  kindVisibilityConditions,
  roleVisibilityConditions,
  type StatusGroup,
} from "./status-groups.js";
import {
  countNeedsYouByScope,
  type SignalsCtx,
} from "../../routers/signals.js";
import { asksYouSessionIds } from "../signals/needs-you-owed.js";
import { resolveBoardLens } from "./board-lens.js";
import { loadOpenWork, type OpenWorkRow } from "./worked-by.js";

const logger = createLogger({ module: "lifecycle-homes" });

/** The home's "done" window: things that entered a done option this week. */
export const HOME_WINDOW_DAYS = 7;
/** Items per column the headline pick looks at (the longest in column first). */
const HEADLINE_CANDIDATES = 3;
/** Worked things per column the needs-you / being-worked headline looks at. */
const WORKED_CANDIDATES = 50;

export type HeadlineReason = "needs_you" | "being_worked" | "stuck" | "recent";

export interface ProducedKind {
  profileSlug: string;
  label: string;
  plural: string;
  live: number;
  total: number;
  doneWindowed: number;
  windowDays: number;
  /** Declared options in order, then the unclassified column when it holds any. */
  columns: Array<{
    key: string;
    label: string;
    category: LifecycleCategory | null;
    count: number;
  }>;
  needsYou: number | null;
  beingWorked: number | null;
  headline: {
    entityId: string;
    title: string | null;
    status: string | null;
    reason: HeadlineReason;
  } | null;
}

export interface SpaceIntent {
  workspaceId: string;
  name: string;
  label: string;
  source: "template" | "inferred";
  kind: "producing" | "library";
  produces: ProducedKind[];
}

export interface HomeRead {
  spaces: SpaceIntent[];
  needsYou: {
    total: number | null;
    bySpace: Array<{ workspaceId: string; count: number | null }>;
  };
}

export type WorkKind = "session" | "worker" | "scheduled";

export interface MovingItem {
  entityId: string;
  title: string | null;
  profileSlug: string | null;
  workspaceId: string | null;
  status: string | null;
  category: string | null;
  work: Array<{
    kind: WorkKind;
    sessionId: string;
    label: string;
    actor?: string;
    live: boolean;
    asksYou: boolean;
    since: string;
  }>;
}

/**
 * The caller context — the signals read's own (`countNeedsYouByScope` takes
 * it as is), so a ctx-shape change fails the build instead of hiding behind a
 * cast.
 */
export type HomesCtx = SignalsCtx & { userId: string };

const readerOf = (ctx: HomesCtx) => ({
  userId: ctx.userId,
  roster: rosterReadFor(ctx),
});

// ─── Spaces + intents ────────────────────────────────────────────────────────

interface HomeSpaceRow {
  id: string;
  name: string;
  settings: Record<string, unknown> | null;
}

/**
 * The caller's visible spaces (member + pod-visible: `getUserWorkspaceIds`,
 * the one door), live ones only. A SYSTEM space (`settings.systemSlug`, e.g.
 * pod-admin) and an agent's own knowledge space (`workspaceType: agent`) are
 * not domains, so a home never lists them.
 */
async function listHomeSpaces(userId: string): Promise<HomeSpaceRow[]> {
  const ids = await getUserWorkspaceIds(userId);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      settings: workspaces.settings,
      workspaceType: workspaces.workspaceType,
    })
    .from(workspaces)
    .where(and(inArray(workspaces.id, ids), isNull(workspaces.archivedAt)));
  return rows
    .filter(
      (r) =>
        r.workspaceType !== "agent" &&
        !(r.settings as { systemSlug?: unknown } | null)?.systemSlug
    )
    .map((r) => ({
      id: r.id,
      name: r.name,
      settings: (r.settings as Record<string, unknown> | null) ?? null,
    }));
}

/** The stored (template) intent, when well-formed. */
function storedIntentOf(
  settings: Record<string, unknown> | null
): { label: string; produces: string[] } | null {
  const intent = settings?.intent as
    { label?: unknown; produces?: unknown } | null | undefined;
  if (!intent || typeof intent.label !== "string" || !intent.label.trim())
    return null;
  const produces = Array.isArray(intent.produces)
    ? intent.produces.filter((s): s is string => typeof s === "string")
    : [];
  return { label: intent.label, produces };
}

/**
 * Counts PER SPACE and profile — what a space with no declared intent
 * produces (homes, `services/lifecycle/homes.ts`): the things of each profile
 * whose OWN space is one of `workspaceIds` (a kind's `entities.workspace_id`,
 * a role's `entity_facets.workspace_id`), under the SAME visibility
 * conditions as `countThingsByProfileAndStatus` (`./status-groups.ts`
 * `kindVisibilityConditions` / `roleVisibilityConditions` — for a role, the
 * facet visibility predicate AND the entity floor), grouped by the space
 * instead of the status. A failed read THROWS.
 */
async function countThingsBySpaceAndProfile(params: {
  kind: "kind" | "role";
  profileIds: string[];
  workspaceIds: string[];
  userId: string;
}): Promise<Array<{ workspaceId: string; profileId: string; count: number }>> {
  if (params.profileIds.length === 0 || params.workspaceIds.length === 0)
    return [];
  const conditions =
    params.kind === "role"
      ? await roleVisibilityConditions({
          userId: params.userId,
          lensWorkspaceId: undefined,
        })
      : kindVisibilityConditions({
          userId: params.userId,
          lensWorkspaceId: undefined,
          explicitWorkspace: false,
          podScopeKind: false,
        });
  const rows =
    params.kind === "role"
      ? await db
          .select({
            workspaceId: drizzleSql<string>`${entityFacets.workspaceId}::text`,
            profileId: entityFacets.profileId,
            count: drizzleSql<number>`cast(count(*) as integer)`,
          })
          .from(entityFacets)
          .innerJoin(entities, eq(entities.id, entityFacets.entityId))
          .where(
            and(
              inArray(entityFacets.profileId, params.profileIds),
              inArray(entityFacets.workspaceId, params.workspaceIds),
              isNull(entityFacets.deletedAt),
              isNull(entities.deletedAt),
              ...conditions
            )
          )
          .groupBy(entityFacets.workspaceId, entityFacets.profileId)
      : await db
          .select({
            workspaceId: drizzleSql<string>`${entities.workspaceId}::text`,
            profileId: entities.profileId,
            count: drizzleSql<number>`cast(count(*) as integer)`,
          })
          .from(entities)
          .where(
            and(
              inArray(entities.profileId, params.profileIds),
              inArray(entities.workspaceId, params.workspaceIds),
              isNull(entities.deletedAt),
              ...conditions
            )
          )
          .groupBy(entities.workspaceId, entities.profileId);
  return rows.map((r) => ({
    workspaceId: r.workspaceId as string,
    profileId: r.profileId as string,
    count: Number(r.count),
  }));
}

/** The profiles that declare a lifecycle (own or inherited). */
async function declaredLifecycleProfileIds(): Promise<string[]> {
  const res = (await db.execute(declaredLifecycleProfilesStatement())) as
    Array<{ profile_id: string }> | { rows: Array<{ profile_id: string }> };
  // postgres.js returns the rows; the PGlite driver (tests) wraps them.
  return (Array.isArray(res) ? res : res.rows).map((r) => r.profile_id);
}

/**
 * INFERRED intents (read time only, never stored): per space, the profiles
 * that declare a lifecycle and have at least one thing IN that space — most
 * things first. A slug with a role row is a role (the board's rule).
 */
async function inferProduces(
  userId: string,
  workspaceIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (workspaceIds.length === 0) return out;
  const declaredIds = await declaredLifecycleProfileIds();
  if (declaredIds.length === 0) return out;
  const profileRows = await db
    .select({
      id: profiles.id,
      slug: profiles.slug,
      profileKind: profiles.profileKind,
    })
    .from(profiles)
    .where(inArray(profiles.id, declaredIds));
  const roleSlugs = new Set(
    profileRows.filter((r) => r.profileKind === "role").map((r) => r.slug)
  );
  const slugOf = new Map(profileRows.map((r) => [r.id, r.slug]));
  const [kindCounts, roleCounts] = await Promise.all([
    countThingsBySpaceAndProfile({
      kind: "kind",
      profileIds: profileRows
        .filter((r) => !roleSlugs.has(r.slug))
        .map((r) => r.id),
      workspaceIds,
      userId,
    }),
    countThingsBySpaceAndProfile({
      kind: "role",
      profileIds: profileRows
        .filter((r) => r.profileKind === "role")
        .map((r) => r.id),
      workspaceIds,
      userId,
    }),
  ]);
  const tally = new Map<string, Map<string, number>>();
  for (const c of [...kindCounts, ...roleCounts]) {
    const slug = slugOf.get(c.profileId);
    if (!slug || c.count === 0) continue;
    let m = tally.get(c.workspaceId);
    if (!m) tally.set(c.workspaceId, (m = new Map()));
    m.set(slug, (m.get(slug) ?? 0) + c.count);
  }
  for (const [ws, m] of tally) {
    out.set(
      ws,
      [...m]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([slug]) => slug)
    );
  }
  return out;
}

/** label + plural per slug: the profile's own words (a role row wins). */
async function profileWords(
  slugs: string[]
): Promise<Map<string, { label: string; plural: string }>> {
  const out = new Map<string, { label: string; plural: string }>();
  if (slugs.length === 0) return out;
  const rows = await db
    .select({
      slug: profiles.slug,
      displayName: profiles.displayName,
      plural: profiles.plural,
      profileKind: profiles.profileKind,
    })
    .from(profiles)
    .where(inArray(profiles.slug, slugs));
  const pick = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const prev = pick.get(r.slug);
    if (!prev || (r.profileKind === "role" && prev.profileKind !== "role"))
      pick.set(r.slug, r);
  }
  for (const [slug, r] of pick) {
    out.set(slug, {
      label: r.displayName,
      plural: r.plural?.trim() || resolveObjectNounPlural(r.displayName),
    });
  }
  return out;
}

// ─── Work on things ──────────────────────────────────────────────────────────

const workKindOf = (w: OpenWorkRow): WorkKind =>
  w.automationId
    ? "worker"
    : w.status === "scheduled"
      ? "scheduled"
      : "session";

// ─── One produced kind ───────────────────────────────────────────────────────

async function readProducedKind(
  ctx: HomesCtx,
  input: {
    workspaceId: string;
    profileSlug: string;
    projectId?: string;
    words: { label: string; plural: string } | undefined;
    /** Open work per thing; null = that read failed. */
    openWork: Map<string, OpenWorkRow[]> | null;
    /** The open sessions that ASK YOU (`asksYouSessionIds`); null = unknown. */
    asksYou: ReadonlySet<string> | null;
    needsYou: number | null;
  }
): Promise<ProducedKind | null> {
  let lens;
  try {
    lens = await resolveBoardLens(
      {
        profileSlug: input.profileSlug,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
      },
      ctx
    );
  } catch (err) {
    // Unknown / undeclared = not a pipeline here (a fact, like lifecycle.list).
    if (
      err instanceof TRPCError &&
      (err.code === "NOT_FOUND" || err.code === "PRECONDITION_FAILED")
    )
      return null;
    throw err;
  }
  const { lifecycle, conditions, subject } = lens;
  const now = Date.now();
  const since = new Date(now - HOME_WINDOW_DAYS * 86_400_000);
  const terminalKeys = new Set(
    lifecycle.options
      .filter((o) => isTerminalLifecycleCategory(o.category))
      .map((o) => o.key)
  );
  const workedIds = input.openWork ? [...input.openWork.keys()] : null;

  const [groups, allCounts, worked] = await Promise.all([
    groupThingsByStatus({
      subject,
      conditions,
      firstN: HEADLINE_CANDIDATES,
      order: "time_in_column",
      terminal: { statuses: [...terminalKeys], since },
    }),
    countThingsByProfileAndStatus({
      kind: subject.kind,
      profileIds: subject.profileIds,
      conditions,
    }),
    // The things of THIS board someone is on: the same grouping, narrowed to
    // the ids that carry open work (bounded by open sessions).
    workedIds === null
      ? Promise.resolve(null)
      : workedIds.length === 0
        ? Promise.resolve([] as StatusGroup[])
        : groupThingsByStatus({
            subject,
            conditions: [...conditions, inArray(entities.id, workedIds) as SQL],
            firstN: WORKED_CANDIDATES,
            order: "time_in_column",
          }),
  ]);

  const byStatus = new Map(groups.map((g) => [g.status, g]));
  const declared = new Set(lifecycle.options.map((o) => o.key));
  const columns: ProducedKind["columns"] = lifecycle.options.map((o) => ({
    key: o.key,
    label: o.label,
    category: o.category,
    count: byStatus.get(o.key)?.count ?? 0,
  }));
  const stray = groups.filter(
    (g) => g.status === null || !declared.has(g.status)
  );
  if (stray.length > 0) {
    columns.push({
      key: UNCLASSIFIED_STATUS,
      label: resolveStatusLabel(UNCLASSIFIED_STATUS),
      category: null,
      count: stray.reduce((n, g) => n + g.count, 0),
    });
  }
  const live = columns
    .filter((c) => !isTerminalLifecycleCategory(c.category))
    .reduce((n, c) => n + c.count, 0);
  const doneWindowed = columns
    .filter((c) => c.category === "done")
    .reduce((n, c) => n + c.count, 0);
  const total = allCounts.reduce((n, g) => n + g.count, 0);

  const isLive = (status: string | null) =>
    status === null || !terminalKeys.has(status);
  const workedLive = worked?.filter((g) => isLive(g.status)) ?? null;
  const beingWorked =
    workedLive === null ? null : workedLive.reduce((n, g) => n + g.count, 0);

  // ── Headline: the ONE thing worth naming, by the first reason that holds.
  type Candidate = { id: string; name: string | null; status: string | null };
  const workedItems: Candidate[] = (workedLive ?? []).flatMap((g) =>
    g.items.map((i) => ({ id: i.id, name: i.name, status: g.status }))
  );
  const workOn = (id: string) => input.openWork?.get(id) ?? [];
  const stuckDays = new Map(
    lifecycle.options.flatMap((o) =>
      o.stuckAfterDays !== undefined && !terminalKeys.has(o.key)
        ? [[o.key, o.stuckAfterDays] as const]
        : []
    )
  );
  const stuckItem = groups
    .flatMap((g) =>
      g.status !== null && stuckDays.has(g.status)
        ? g.items
            .filter(
              (i) =>
                Date.parse(i.since) <
                now - stuckDays.get(g.status!)! * 86_400_000
            )
            .map((i) => ({ ...i, status: g.status }))
        : []
    )
    .sort((a, b) => a.since.localeCompare(b.since))[0];
  const recentItem = groups
    .flatMap((g) => g.items.map((i) => ({ ...i, status: g.status })))
    .sort((a, b) => b.since.localeCompare(a.since))[0];

  const pick = (
    c: Candidate | undefined,
    reason: HeadlineReason
  ): ProducedKind["headline"] =>
    c ? { entityId: c.id, title: c.name, status: c.status, reason } : null;
  const asksYou = input.asksYou;
  const headline =
    // An unknown asks-you set skips the reason it could not read.
    pick(
      asksYou
        ? workedItems.find((c) =>
            workOn(c.id).some((w) => asksYou.has(w.sessionId))
          )
        : undefined,
      "needs_you"
    ) ??
    pick(
      workedItems.find((c) => workOn(c.id).some((w) => w.live)),
      "being_worked"
    ) ??
    pick(
      stuckItem && {
        id: stuckItem.id,
        name: stuckItem.name,
        status: stuckItem.status,
      },
      "stuck"
    ) ??
    pick(
      recentItem && {
        id: recentItem.id,
        name: recentItem.name,
        status: recentItem.status,
      },
      "recent"
    );

  return {
    profileSlug: input.profileSlug,
    label: input.words?.label ?? resolveObjectNoun(input.profileSlug),
    plural: input.words?.plural ?? resolveObjectNounPlural(input.profileSlug),
    live,
    total,
    doneWindowed,
    windowDays: HOME_WINDOW_DAYS,
    columns,
    needsYou: input.needsYou,
    beingWorked,
    headline,
  };
}

// ─── lifecycle.home ──────────────────────────────────────────────────────────

export async function readHome(
  ctx: HomesCtx,
  input: { projectId?: string }
): Promise<HomeRead> {
  const spaces = await listHomeSpaces(ctx.userId);
  const stored = new Map(spaces.map((s) => [s.id, storedIntentOf(s.settings)]));
  const inferred = await inferProduces(
    ctx.userId,
    spaces.filter((s) => !stored.get(s.id)).map((s) => s.id)
  );
  const intents = spaces.map((s) => {
    const own = stored.get(s.id);
    return own
      ? {
          space: s,
          label: own.label,
          source: "template" as const,
          produces: own.produces,
        }
      : {
          space: s,
          label: s.name,
          source: "inferred" as const,
          produces: inferred.get(s.id) ?? [],
        };
  });

  const settle = async <T>(what: string, read: () => Promise<T>) => {
    try {
      return await read();
    } catch (err) {
      logger.warn({ err, what }, "home sub-read failed — reported as null");
      return null;
    }
  };

  const openWorkAndAsks = async () => {
    const work = await loadOpenWork(readerOf(ctx), null);
    const asks = await settle("asks you", () =>
      asksYouSessionIds(
        ctx.userId,
        [...work.values()].flatMap((rows) => rows.map((w) => w.sessionId))
      )
    );
    return { work, asks };
  };
  const [words, open, needs] = await Promise.all([
    profileWords([...new Set(intents.flatMap((i) => i.produces))]),
    settle("open work", openWorkAndAsks),
    // ONE attention read for every scope on the page (null per failed scope).
    settle("needs-you", () =>
      countNeedsYouByScope(ctx, {
        ...(input.projectId ? { projectId: input.projectId } : {}),
        spaces: intents.map((i) => ({
          workspaceId: i.space.id,
          profileSlugs: i.produces,
        })),
      })
    ),
  ]);
  const total = needs?.total ?? null;
  const bySpace = spaces.map((s) => ({
    workspaceId: s.id,
    count: needs?.bySpace.get(s.id) ?? null,
  }));
  const byKind = intents.map(
    (i) => needs?.byKind.get(i.space.id) ?? new Map<string, number | null>()
  );

  const out = await Promise.all(
    intents.map(async (i, idx): Promise<SpaceIntent> => {
      const produced = (
        await Promise.all(
          i.produces.map((profileSlug) =>
            readProducedKind(ctx, {
              workspaceId: i.space.id,
              profileSlug,
              projectId: input.projectId,
              words: words.get(profileSlug),
              openWork: open?.work ?? null,
              asksYou: open?.asks ?? null,
              needsYou: byKind[idx]!.get(profileSlug) ?? null,
            })
          )
        )
      ).filter((p): p is ProducedKind => p !== null);
      return {
        workspaceId: i.space.id,
        name: i.space.name,
        label: i.label,
        source: i.source,
        kind: produced.length > 0 ? "producing" : "library",
        produces: produced,
      };
    })
  );

  const liveOf = (s: SpaceIntent) => s.produces.reduce((n, p) => n + p.live, 0);
  out.sort(
    (a, b) =>
      Number(b.kind === "producing") - Number(a.kind === "producing") ||
      liveOf(b) - liveOf(a) ||
      a.name.localeCompare(b.name)
  );
  return { spaces: out, needsYou: { total, bySpace } };
}

// ─── lifecycle.moving ────────────────────────────────────────────────────────

/**
 * A moving thing's IDENTITY: which produced pipeline it sits in. A kind's is
 * the entity's own (`entities.profile_id` / `status` / `workspace_id`); a
 * ROLE's is its facet's (`entity_facets.profile_id` / `status` /
 * `status_category` / `workspace_id`) — a lead is a person whose LEAD stage
 * lives on the facet, in the Sales space, not on the person (homes review M1).
 *
 * The rule: the entity's own kind when ITS space produces it; else a role
 * facet (visible to the caller: `roleVisibilityConditions`) in a space that
 * produces that role — a facet's own space, or, for a pod-wide facet (a
 * shared role is stored with no space), each space whose stored intent
 * produces the role — the one in the narrowed space when the read is
 * narrowed, else the most recently moved facet; else the entity's own kind
 * (an unproduced thing still moves, named by what it is). "Produces" is THE
 * home's rule: the space's stored intent lists the slug, or — a space with no
 * stored intent — the slug declares a lifecycle (the inference counts this
 * very thing, so it is produced there).
 */
interface MovingIdentity {
  profileSlug: string | null;
  workspaceId: string | null;
  status: string | null;
  category: string | null;
}

async function resolveMovingIdentities(
  userId: string,
  things: ReadonlyArray<{
    id: string;
    type: string | null;
    profileId: string | null;
    workspaceId: string | null;
    status: string | null;
    category: string | null;
  }>,
  narrowTo: string | undefined
): Promise<Map<string, MovingIdentity>> {
  const [spaces, declared, roleConds] = await Promise.all([
    listHomeSpaces(userId),
    declaredLifecycleProfileIds(),
    roleVisibilityConditions({ userId, lensWorkspaceId: undefined }),
  ]);
  const declaredIds = new Set(declared);
  const intentOf = new Map(
    spaces.map((s) => [s.id, storedIntentOf(s.settings)])
  );
  const produces = (
    workspaceId: string | null,
    slug: string,
    profileId: string
  ): boolean => {
    if (!workspaceId || !intentOf.has(workspaceId)) return false;
    const stored = intentOf.get(workspaceId);
    return stored ? stored.produces.includes(slug) : declaredIds.has(profileId);
  };

  // The spaces whose STORED intent produces a slug, by name (stable order).
  const storedProducers = new Map<string, string[]>();
  for (const sp of [...spaces].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const slug of intentOf.get(sp.id)?.produces ?? []) {
      storedProducers.set(slug, [...(storedProducers.get(slug) ?? []), sp.id]);
    }
  }

  const profileIds = [
    ...new Set(things.map((t) => t.profileId).filter((x): x is string => !!x)),
  ];
  const [kindSlugRows, facetRows] = await Promise.all([
    profileIds.length
      ? db
          .select({ id: profiles.id, slug: profiles.slug })
          .from(profiles)
          .where(inArray(profiles.id, profileIds))
      : Promise.resolve([] as Array<{ id: string; slug: string }>),
    db
      .select({
        entityId: entityFacets.entityId,
        profileId: entityFacets.profileId,
        slug: profiles.slug,
        workspaceId: entityFacets.workspaceId,
        status: entityFacets.status,
        category: entityFacets.statusCategory,
        updatedAt: entityFacets.updatedAt,
      })
      .from(entityFacets)
      .innerJoin(entities, eq(entities.id, entityFacets.entityId))
      .innerJoin(profiles, eq(profiles.id, entityFacets.profileId))
      .where(
        and(
          inArray(
            entityFacets.entityId,
            things.map((t) => t.id)
          ),
          eq(profiles.profileKind, "role"),
          isNull(entityFacets.deletedAt),
          ...roleConds
        )
      ),
  ]);
  const slugOf = new Map(kindSlugRows.map((r) => [r.id, r.slug]));
  const facetsOf = new Map<string, typeof facetRows>();
  for (const f of facetRows) {
    const list = facetsOf.get(f.entityId) ?? [];
    list.push(f);
    facetsOf.set(f.entityId, list);
  }

  const out = new Map<string, MovingIdentity>();
  for (const t of things) {
    const kindSlug = (t.profileId && slugOf.get(t.profileId)) || t.type || null;
    const own: MovingIdentity = {
      profileSlug: kindSlug,
      workspaceId: t.workspaceId ?? null,
      status: t.status ?? null,
      category: t.category ?? null,
    };
    const candidates: MovingIdentity[] = [];
    if (
      kindSlug &&
      t.profileId &&
      produces(t.workspaceId, kindSlug, t.profileId)
    )
      candidates.push(own);
    for (const f of (facetsOf.get(t.id) ?? []).sort(
      (a, b) =>
        new Date(b.updatedAt ?? 0).getTime() -
        new Date(a.updatedAt ?? 0).getTime()
    )) {
      if (!f.profileId) continue;
      // A pod-wide facet (a shared role is stored with no space) sits in
      // every space whose intent produces that role — the lens the board of
      // each of those spaces reads it under (`facetVisibilityConditions`).
      const homes = f.workspaceId
        ? [f.workspaceId]
        : (storedProducers.get(f.slug) ?? []);
      for (const ws of homes) {
        if (!produces(ws, f.slug, f.profileId)) continue;
        candidates.push({
          profileSlug: f.slug,
          workspaceId: ws,
          status: f.status ?? null,
          category: f.category ?? null,
        });
      }
    }
    // Narrowed: the identity IN that space when it has one; else its first
    // (so a thing produced elsewhere falls OUT of the narrowed list).
    out.set(
      t.id,
      (narrowTo && candidates.find((c) => c.workspaceId === narrowTo)) ||
        candidates[0] ||
        own
    );
  }
  return out;
}

/**
 * The things with open work on them, most urgent first: one whose work asks
 * you, then one being worked right now, then the longest-running. Each names
 * its produced identity (`resolveMovingIdentities`: a role's facet status and
 * space, never the person's). Narrowed to that identity's space
 * (`workspaceId`) and/or the project. A failed read THROWS — "nothing is
 * moving" is a claim this read must have earned.
 */
export async function readMoving(
  ctx: HomesCtx,
  input: { projectId?: string; workspaceId?: string; limit: number }
): Promise<{ items: MovingItem[] }> {
  const work = await loadOpenWork(readerOf(ctx), null);
  const ids = [...work.keys()];
  if (ids.length === 0) return { items: [] };

  const things = await db
    .select({
      id: entities.id,
      title: entities.title,
      type: entities.type,
      profileId: entities.profileId,
      workspaceId: entities.workspaceId,
      status: entities.status,
      category: entities.statusCategory,
    })
    .from(entities)
    .where(
      and(
        inArray(entities.id, ids),
        isNull(entities.deletedAt),
        ...kindVisibilityConditions({
          userId: ctx.userId,
          lensWorkspaceId: undefined,
          explicitWorkspace: false,
          podScopeKind: false,
        }),
        ...(input.projectId
          ? [projectLensWhere(entities.id, input.projectId) as SQL]
          : [])
      )
    );
  if (things.length === 0) return { items: [] };

  const [identities, names, asksYou] = await Promise.all([
    resolveMovingIdentities(ctx.userId, things, input.workspaceId),
    resolveActorNames(
      things.flatMap((t) =>
        (work.get(t.id) ?? []).map((w) => w.agentIds[0] ?? "")
      )
    ),
    // THE needs-you owed predicate (owner floor, drafts out), never a slot scan.
    asksYouSessionIds(
      ctx.userId,
      things.flatMap((t) => (work.get(t.id) ?? []).map((w) => w.sessionId))
    ),
  ]);
  const inScope = things.filter(
    (t) =>
      !input.workspaceId ||
      identities.get(t.id)?.workspaceId === input.workspaceId
  );

  const items: Array<MovingItem & { rank: [number, number, number] }> =
    inScope.map((t) => {
      const rows = work.get(t.id) ?? [];
      const lines = rows.map((w) => {
        const actor = w.agentIds[0] ? names.get(w.agentIds[0]) : undefined;
        return {
          kind: workKindOf(w),
          sessionId: w.sessionId,
          label: resolveSessionTitle({ title: w.title, goal: w.goal }),
          ...(actor ? { actor } : {}),
          live: w.live,
          asksYou: asksYou.has(w.sessionId),
          since: w.startedAt.toISOString(),
        };
      });
      lines.sort(
        (a, b) =>
          Number(b.asksYou) - Number(a.asksYou) ||
          Number(b.live) - Number(a.live) ||
          a.since.localeCompare(b.since)
      );
      const earliest = lines.reduce(
        (m, l) => Math.min(m, Date.parse(l.since)),
        Number.POSITIVE_INFINITY
      );
      const id = identities.get(t.id)!;
      return {
        entityId: t.id,
        title: t.title ?? null,
        profileSlug: id.profileSlug,
        workspaceId: id.workspaceId,
        status: id.status,
        category: id.category,
        work: lines,
        rank: [
          Number(lines.some((l) => l.asksYou)),
          Number(lines.some((l) => l.live)),
          earliest,
        ],
      };
    });
  items.sort(
    (a, b) =>
      b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || a.rank[2] - b.rank[2]
  );
  return {
    items: items.slice(0, input.limit).map(({ rank: _rank, ...item }) => item),
  };
}
