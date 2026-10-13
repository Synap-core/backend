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
 *   - needs-you is `signals.count` / `signals.countByProfile` themselves;
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
  notProbeEntityWhere,
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
import type { ExpectedOutput } from "@synap/playbooks";
import { getUserWorkspaceIds } from "../../utils/workspace-membership.js";
import { projectLensWhere } from "../../utils/project-scope.js";
import { resolveActorNames } from "../../utils/resolve-actor-names.js";
import { rosterReadFor } from "../../access/session-visibility.js";
import { entityReadVisibleWhere } from "../../routers/entities/helpers.js";
import {
  countThingsByProfileAndStatus,
  groupThingsByStatus,
  type StatusGroup,
} from "../../routers/entities/status-groups.js";
import { signalsRouter } from "../../routers/signals.js";
import { isOwedSlot } from "../focus-sessions/owed-outputs.js";
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

/** What the trpc ctx carries that these reads use. */
export interface HomesCtx {
  userId: string;
  workspaceId?: string | null;
  agentUserId?: string | null;
}

type SignalsCaller = ReturnType<typeof signalsRouter.createCaller>;
const signalsOf = (ctx: HomesCtx): SignalsCaller =>
  signalsRouter.createCaller(
    ctx as unknown as Parameters<typeof signalsRouter.createCaller>[0]
  );

const readerOf = (ctx: HomesCtx) => ({
  userId: ctx.userId,
  roster: rosterReadFor(ctx as never),
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
 * a role's `entity_facets.workspace_id`), under the caller's entity floor.
 * The same base rows as `countThingsByProfileAndStatus`
 * (`routers/entities/status-groups.ts`), grouped by the space instead of the
 * status. A failed read THROWS.
 */
async function countThingsBySpaceAndProfile(params: {
  kind: "kind" | "role";
  profileIds: string[];
  workspaceIds: string[];
  userId: string;
}): Promise<Array<{ workspaceId: string; profileId: string; count: number }>> {
  if (params.profileIds.length === 0 || params.workspaceIds.length === 0)
    return [];
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
              entityReadVisibleWhere(params.userId) as SQL
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
              notProbeEntityWhere() as SQL,
              entityReadVisibleWhere(params.userId) as SQL
            )
          )
          .groupBy(entities.workspaceId, entities.profileId);
  return rows.map((r) => ({
    workspaceId: r.workspaceId as string,
    profileId: r.profileId as string,
    count: Number(r.count),
  }));
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
  const res = (await db.execute(declaredLifecycleProfilesStatement())) as
    Array<{ profile_id: string }> | { rows: Array<{ profile_id: string }> };
  // postgres.js returns the rows; the PGlite driver (tests) wraps them.
  const declaredIds = (Array.isArray(res) ? res : res.rows).map(
    (r) => r.profile_id
  );
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

const asksYouOf = (w: OpenWorkRow): boolean =>
  Array.isArray(w.expectedOutputs) &&
  (w.expectedOutputs as ExpectedOutput[]).some(
    (slot) => !!slot && typeof slot === "object" && isOwedSlot(slot)
  );

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
  const headline =
    pick(
      workedItems.find((c) => workOn(c.id).some(asksYouOf)),
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

  const signals = signalsOf(ctx);
  const lens = input.projectId ? { projectId: input.projectId } : {};
  const settle = async <T>(what: string, read: () => Promise<T>) => {
    try {
      return await read();
    } catch (err) {
      logger.warn({ err, what }, "home sub-read failed — reported as null");
      return null;
    }
  };

  const [words, openWork, total, bySpace, byKind] = await Promise.all([
    profileWords([...new Set(intents.flatMap((i) => i.produces))]),
    settle("open work", () => loadOpenWork(readerOf(ctx), null)),
    settle(
      "needs-you total",
      async () => (await signals.count({ ...lens })).needsYou
    ),
    Promise.all(
      spaces.map(async (s) => ({
        workspaceId: s.id,
        count: await settle(
          "needs-you space",
          async () =>
            (await signals.count({ ...lens, workspaceId: s.id })).needsYou
        ),
      }))
    ),
    Promise.all(
      intents.map(async (i) => {
        if (i.produces.length === 0) return new Map<string, number | null>();
        const rows = await settle("needs-you kinds", () =>
          signals.countByProfile({
            ...lens,
            workspaceId: i.space.id,
            profileSlugs: i.produces,
          })
        );
        return new Map(
          i.produces.map((slug) => {
            const r = rows?.find((x) => x.profileSlug === slug);
            return [
              slug,
              r && r.status === "ok" ? r.count.needsYou : null,
            ] as const;
          })
        );
      })
    ),
  ]);

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
              openWork,
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
 * The things with open work on them, most urgent first: one whose work asks
 * you, then one being worked right now, then the longest-running. Narrowed to
 * the thing's space (`workspaceId`) and/or project. A failed read THROWS —
 * "nothing is moving" is a claim this read must have earned.
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
        notProbeEntityWhere() as SQL,
        entityReadVisibleWhere(ctx.userId) as SQL,
        ...(input.workspaceId
          ? [eq(entities.workspaceId, input.workspaceId)]
          : []),
        ...(input.projectId
          ? [projectLensWhere(entities.id, input.projectId) as SQL]
          : [])
      )
    );
  if (things.length === 0) return { items: [] };

  const profileIds = [
    ...new Set(things.map((t) => t.profileId).filter((x): x is string => !!x)),
  ];
  const [slugRows, names] = await Promise.all([
    profileIds.length
      ? db
          .select({ id: profiles.id, slug: profiles.slug })
          .from(profiles)
          .where(inArray(profiles.id, profileIds))
      : Promise.resolve([] as Array<{ id: string; slug: string }>),
    resolveActorNames(
      things.flatMap((t) =>
        (work.get(t.id) ?? []).map((w) => w.agentIds[0] ?? "")
      )
    ),
  ]);
  const slugOf = new Map(slugRows.map((r) => [r.id, r.slug]));

  const items: Array<MovingItem & { rank: [number, number, number] }> =
    things.map((t) => {
      const rows = work.get(t.id) ?? [];
      const lines = rows.map((w) => {
        const actor = w.agentIds[0] ? names.get(w.agentIds[0]) : undefined;
        return {
          kind: workKindOf(w),
          sessionId: w.sessionId,
          label: resolveSessionTitle({ title: w.title, goal: w.goal }),
          ...(actor ? { actor } : {}),
          live: w.live,
          asksYou: asksYouOf(w),
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
      return {
        entityId: t.id,
        title: t.title ?? null,
        profileSlug: (t.profileId && slugOf.get(t.profileId)) || t.type || null,
        workspaceId: t.workspaceId ?? null,
        status: t.status ?? null,
        category: t.category ?? null,
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
