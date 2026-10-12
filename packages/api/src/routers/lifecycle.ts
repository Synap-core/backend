/**
 * lifecycle — the read model of a kind's or role's lifecycle (work model L1/L3).
 *
 *   lifecycle.get   — the declared lifecycle of ONE profile (the thing page's
 *                     status strip): property + options with label, category,
 *                     tone, humanOnly — words and marks resolved here, once.
 *   lifecycle.board — the PIPELINE: things of that kind/role grouped by status
 *                     column, options in declared order, done/lost windowed to
 *                     the period, values no option declares in an explicit
 *                     `unclassified` column (never dropped), and the shape the
 *                     surface should default to (W17: a list below ~10 live
 *                     things or with no worker).
 *
 * Grouping is THE ONE status grouping (`entities/status-groups.ts`, shared with
 * `entities.groupByFacetStatus`); visibility is the access layer's (entity
 * floor + facet lens + project narrow). A failed read throws — never `[]`.
 *
 * `trackId` filters by the TRACK'S PROJECT. (L7 adds the track's enabled
 * workers; until then a track lens is its project lens, documented here.)
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, podProcedure } from "../trpc.js";
import {
  db,
  inArray,
  declaredLifecycleProfilesStatement,
  ProfileResolutionService,
  type EffectiveLifecycle,
} from "@synap/database";
import { profiles } from "@synap/database/schema";
import {
  LIFECYCLE_CATEGORIES,
  isTerminalLifecycleCategory,
  lifecycleOptionLabel,
  lifecycleOptionTone,
} from "@synap-core/types/lifecycle";
import { assertKnownProfileSlug } from "../utils/assert-known-profile-slug.js";
import { getTrack } from "../services/tracks/tracks-service.js";
import { listEnabledWorkers } from "../services/playbooks/workers.js";
import {
  countThingsByProfileAndStatus,
  groupThingsByStatus,
  kindVisibilityConditions,
  pageThingsInColumn,
  roleVisibilityConditions,
  statusSubjectOfRows,
} from "./entities/status-groups.js";

/** W17: below this many LIVE things a pipeline defaults to a list. */
export const BOARD_LIST_THRESHOLD = 10;
/** The key of the column holding values no option declares. */
export const UNCLASSIFIED_COLUMN = "__unclassified";

const categorySchema = z.enum(LIFECYCLE_CATEGORIES);

const lifecycleOptionWire = z.object({
  key: z.string(),
  label: z.string(),
  category: categorySchema,
  tone: z.string(),
  humanOnly: z.boolean(),
});

const lifecycleWire = z.object({
  profileSlug: z.string(),
  profileKind: z.enum(["kind", "role"]),
  property: z.string(),
  options: z.array(lifecycleOptionWire),
});

const boardItemWire = z.object({
  id: z.string(),
  /** A role board's facet — what a role status move (`updateFacet`) targets; null on a kind board. */
  facetId: z.string().nullable(),
  name: z.string().nullable(),
  /** The raw stored status (useful in the unclassified column). */
  status: z.string().nullable(),
  /** The last transition into this status; null = none recorded. */
  enteredAt: z.string().nullable(),
  /** Time-in-column origin: `enteredAt`, else when it took the role / was created. */
  since: z.string(),
});

const boardColumnWire = z.object({
  /** An option key, or `__unclassified`. */
  key: z.string(),
  /** Null for the unclassified column. */
  category: categorySchema.nullable(),
  count: z.number(),
  items: z.array(boardItemWire),
  /** done/lost columns count only what entered within the window. */
  windowed: z.boolean(),
});

const boardWire = z.object({
  lifecycle: lifecycleWire,
  columns: z.array(boardColumnWire),
  /** Things that entered a `done` option within the window. */
  doneWindowed: z.number(),
  /** Things that entered a `lost` option within the window. */
  lostWindowed: z.number(),
  /** Every visible thing under the filter, all statuses, unwindowed. */
  total: z.number(),
  /** Open + active + paused + unclassified — the work still in the pipeline. */
  live: z.number(),
  /** A LIVE worker enablement covers this board (its project, or the whole space). */
  hasWorker: z.boolean(),
  /** W17: `list` below ~10 live things or with no worker. */
  suggestedShape: z.enum(["board", "list"]),
  window: z.object({ days: z.number(), since: z.string() }),
  /**
   * A COLUMN read (`column` given): the cursor of the next page of that
   * column, null when it is the last. Always null on a whole board.
   */
  nextCursor: z.string().nullable(),
});

const lifecycleSummaryWire = z.object({
  profileSlug: z.string(),
  profileKind: z.enum(["kind", "role"]),
  /** The profile's own name (a role or kind's display name). */
  label: z.string(),
  /** Open + active + paused + unclassified things in scope (the board's `live`). */
  live: z.number(),
  /** Every visible thing in scope, all statuses. */
  total: z.number(),
});

export type LifecycleWire = z.infer<typeof lifecycleWire>;
export type LifecycleBoardWire = z.infer<typeof boardWire>;
export type LifecycleSummaryWire = z.infer<typeof lifecycleSummaryWire>;

/** A column page cursor is the offset into the column, as a string. */
function readCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor." });
  }
  return n;
}

interface ResolvedProfile {
  profileKind: "kind" | "role";
  profileIds: string[];
  podScopeKind: boolean;
  lifecycle: EffectiveLifecycle;
}

/**
 * The slug → its rows of ONE kind (a role row wins: a slug that is a role
 * groups facets) and the effective lifecycle of the first row that declares
 * one. No declaration → PRECONDITION_FAILED naming the fix (a lifecycle is
 * declared once, on the profile — never guessed from a select's name).
 */
async function resolveProfileLifecycle(
  profileSlug: string,
  workspaceId: string | null | undefined
): Promise<ResolvedProfile> {
  const rows = await assertKnownProfileSlug(db, profileSlug);
  const { chosen, profileKind, podScopeKind } = statusSubjectOfRows(
    profileSlug,
    rows
  );
  const resolver = new ProfileResolutionService(db);
  let lifecycle: EffectiveLifecycle | null = null;
  for (const r of chosen) {
    lifecycle = await resolver.getEffectiveLifecycle(r.id, workspaceId ?? null);
    if (lifecycle) break;
  }
  if (!lifecycle || lifecycle.options.length === 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `"${profileSlug}" has no declared lifecycle, so it has no pipeline. ` +
        `Declare one on the profile (lifecycle: { property, options: [{ key, category }] }) ` +
        `— categories are open · active · paused · done · lost.`,
    });
  }
  return {
    profileKind,
    profileIds: chosen.map((r) => r.id),
    podScopeKind,
    lifecycle,
  };
}

function toLifecycleWire(
  profileSlug: string,
  p: ResolvedProfile
): LifecycleWire {
  return {
    profileSlug,
    profileKind: p.profileKind,
    property: p.lifecycle.propertySlug,
    options: p.lifecycle.options.map((o) => ({
      key: o.key,
      label: lifecycleOptionLabel(o),
      category: o.category,
      tone: lifecycleOptionTone(o),
      humanOnly: o.humanOnly === true,
    })),
  };
}

export const lifecycleRouter = router({
  get: podProcedure
    .input(
      z.object({
        profileSlug: z.string().min(1),
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .output(lifecycleWire)
    .query(async ({ input, ctx }) => {
      const p = await resolveProfileLifecycle(
        input.profileSlug,
        input.workspaceId !== undefined
          ? input.workspaceId
          : (ctx.workspaceId ?? null)
      );
      return toLifecycleWire(input.profileSlug, p);
    }),

  board: podProcedure
    .input(
      z.object({
        /** A kind (grouped by `entities.status`) or a role (by facet status). */
        profileSlug: z.string().min(1),
        projectId: z.string().uuid().optional(),
        /** The track's project (L7 will add its enabled workers). */
        trackId: z.string().uuid().optional(),
        /** `undefined` → the active workspace header; `null` → pod-wide only. */
        workspaceId: z.string().uuid().nullable().optional(),
        /** done/lost columns count what entered them within the last N days. */
        window: z
          .object({ days: z.number().int().min(1).max(366) })
          .default({ days: 30 }),
        /** Items per column (capped list; the count is always exact). */
        firstN: z.number().int().min(0).max(50).default(10),
        /**
         * "Show all N" on one column: an option key or `__unclassified`.
         * The answer's `columns` then holds ONLY that column, its items
         * paged (`limit` from `cursor`), in the board's own order and
         * window; every count and total stays the whole board's.
         */
        column: z.string().min(1).optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      })
    )
    .output(boardWire)
    .query(async ({ input, ctx }) => {
      let projectId = input.projectId;
      if (input.trackId) {
        const track = await getTrack(input.trackId, {
          userId: ctx.userId,
          agentUserId: (ctx as { agentUserId?: string | null }).agentUserId,
        });
        if (!track) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Track not found",
          });
        }
        if (projectId && projectId !== track.projectId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "trackId belongs to another project than projectId.",
          });
        }
        projectId = track.projectId;
      }
      const lensWorkspaceId =
        input.workspaceId !== undefined
          ? input.workspaceId
          : (ctx.workspaceId ?? undefined);
      const p = await resolveProfileLifecycle(
        input.profileSlug,
        lensWorkspaceId
      );
      const lifecycle = toLifecycleWire(input.profileSlug, p);

      const conditions =
        p.profileKind === "role"
          ? await roleVisibilityConditions({
              userId: ctx.userId,
              lensWorkspaceId,
              projectId,
            })
          : kindVisibilityConditions({
              userId: ctx.userId,
              lensWorkspaceId,
              explicitWorkspace: input.workspaceId !== undefined,
              projectId,
              podScopeKind: p.podScopeKind,
            });
      const subject =
        p.profileKind === "role"
          ? {
              kind: "role" as const,
              profileIds: p.profileIds,
              roleSlug: input.profileSlug,
            }
          : { kind: "kind" as const, profileIds: p.profileIds };

      const since = new Date(Date.now() - input.window.days * 86_400_000);
      const terminalKeys = lifecycle.options
        .filter((o) => isTerminalLifecycleCategory(o.category))
        .map((o) => o.key);
      const [groups, allCounts] = await Promise.all([
        groupThingsByStatus({
          subject,
          conditions,
          // A column read pages that column below; the rest are counts.
          firstN: input.column ? 0 : input.firstN,
          order: "time_in_column",
          terminal: { statuses: terminalKeys, since },
        }),
        // `total` is unwindowed: the same base rows, counts only — no second
        // grouping, no time-in-column read (review backend F3).
        countThingsByProfileAndStatus({
          kind: subject.kind,
          profileIds: subject.profileIds,
          conditions,
        }),
      ]);

      const byStatus = new Map(groups.map((g) => [g.status, g]));
      const columns: LifecycleBoardWire["columns"] = lifecycle.options.map(
        (o) => {
          const g = byStatus.get(o.key);
          return {
            key: o.key,
            category: o.category,
            count: g?.count ?? 0,
            items: (g?.items ?? []).map((i) => ({ ...i, status: o.key })),
            windowed: isTerminalLifecycleCategory(o.category),
          };
        }
      );
      // Values no option declares (an undeclared value, a pre-door write, no
      // status at all): ONE explicit column, never dropped.
      const declared = new Set(lifecycle.options.map((o) => o.key));
      const stray = groups.filter(
        (g) => g.status === null || !declared.has(g.status)
      );
      if (stray.length > 0) {
        columns.push({
          key: UNCLASSIFIED_COLUMN,
          category: null,
          count: stray.reduce((n, g) => n + g.count, 0),
          items: stray
            .flatMap((g) => g.items.map((i) => ({ ...i, status: g.status })))
            .sort((a, b) => a.since.localeCompare(b.since))
            .slice(0, input.firstN),
          windowed: false,
        });
      }

      const sumBy = (cat: string) =>
        columns
          .filter((c) => c.category === cat)
          .reduce((n, c) => n + c.count, 0);
      const live = columns
        .filter((c) => !isTerminalLifecycleCategory(c.category))
        .reduce((n, c) => n + c.count, 0);
      const total = allCounts.reduce((n, g) => n + g.count, 0);
      // A LIVE enablement (not paused, its automation active) whose scope
      // covers this board's filter — the ONE reader the track page uses too.
      const hasWorker =
        (
          await listEnabledWorkers({
            userId: ctx.userId,
            profileSlug: input.profileSlug,
            projectId: projectId ?? null,
            liveOnly: true,
          })
        ).length > 0;

      let shownColumns = columns;
      let nextCursor: string | null = null;
      if (input.column) {
        const col =
          columns.find((c) => c.key === input.column) ??
          // An unclassified column with nothing in it is still a column a
          // caller may ask for (it answers empty).
          (input.column === UNCLASSIFIED_COLUMN
            ? {
                key: UNCLASSIFIED_COLUMN,
                category: null,
                count: 0,
                items: [],
                windowed: false,
              }
            : null);
        if (!col) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `"${input.column}" is not a status of ${input.profileSlug}.`,
          });
        }
        const offset = readCursor(input.cursor);
        const page = await pageThingsInColumn({
          subject,
          conditions,
          order: "time_in_column",
          terminal: { statuses: terminalKeys, since },
          column:
            col.key === UNCLASSIFIED_COLUMN
              ? { outside: [...declared] }
              : { statuses: [col.key] },
          offset,
          limit: input.limit,
        });
        shownColumns = [{ ...col, items: page.items }];
        nextCursor = page.hasMore ? String(offset + input.limit) : null;
      }

      return {
        lifecycle,
        columns: shownColumns,
        doneWindowed: sumBy("done"),
        lostWindowed: sumBy("lost"),
        total,
        live,
        hasWorker,
        suggestedShape:
          live < BOARD_LIST_THRESHOLD || !hasWorker ? "list" : "board",
        window: { days: input.window.days, since: since.toISOString() },
        nextCursor,
      };
    }),

  /**
   * The pipelines IN SCOPE (a project's pipeline doors): every kind AND role
   * that declares a lifecycle and has at least one LIVE thing (not in a
   * done/lost option) under the filter, with its counts. Live first, then by
   * name. Visibility is the board's (same conditions per kind/role), so a door
   * never promises a pipeline the board then reads as empty.
   */
  list: podProcedure
    .input(
      z.object({
        projectId: z.string().uuid().optional(),
        /** `undefined` → the active workspace header; `null` → pod-wide only. */
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .output(z.array(lifecycleSummaryWire))
    .query(async ({ input, ctx }) => {
      const lensWorkspaceId =
        input.workspaceId !== undefined
          ? input.workspaceId
          : (ctx.workspaceId ?? undefined);
      // Only profiles that declare (or inherit) a lifecycle are pipelines:
      // count those, never every kind in the pod (review backend F4).
      const res = (await db.execute(declaredLifecycleProfilesStatement())) as
        Array<{ profile_id: string }> | { rows: Array<{ profile_id: string }> };
      // postgres.js returns the rows; the PGlite driver (tests) wraps them.
      const declared = Array.isArray(res) ? res : res.rows;
      const declaredIds = declared.map((r) => r.profile_id);
      if (declaredIds.length === 0) return [];
      const profileRows = await db
        .select({
          id: profiles.id,
          slug: profiles.slug,
          displayName: profiles.displayName,
          profileKind: profiles.profileKind,
          entityScope: profiles.entityScope,
        })
        .from(profiles)
        .where(inArray(profiles.id, declaredIds));
      // A slug with a role row is a role (the board's rule).
      const roleSlugs = new Set(
        profileRows.filter((r) => r.profileKind === "role").map((r) => r.slug)
      );
      const roleIds = profileRows
        .filter((r) => r.profileKind === "role")
        .map((r) => r.id);
      const kindRows = profileRows.filter((r) => !roleSlugs.has(r.slug));
      // The board reads a slug as pod-scope when ANY of its rows is.
      const podSlugs = new Set(
        kindRows.filter((r) => r.entityScope === "pod").map((r) => r.slug)
      );
      const kindConds = (podScopeKind: boolean) =>
        kindVisibilityConditions({
          userId: ctx.userId,
          lensWorkspaceId,
          explicitWorkspace: input.workspaceId !== undefined,
          projectId: input.projectId,
          podScopeKind,
        });
      const [podKindCounts, wsKindCounts, roleCounts] = await Promise.all([
        countThingsByProfileAndStatus({
          kind: "kind",
          profileIds: kindRows
            .filter((r) => podSlugs.has(r.slug))
            .map((r) => r.id),
          conditions: kindConds(true),
        }),
        countThingsByProfileAndStatus({
          kind: "kind",
          profileIds: kindRows
            .filter((r) => !podSlugs.has(r.slug))
            .map((r) => r.id),
          conditions: kindConds(false),
        }),
        roleVisibilityConditions({
          userId: ctx.userId,
          lensWorkspaceId,
          projectId: input.projectId,
        }).then((conditions) =>
          countThingsByProfileAndStatus({
            kind: "role",
            profileIds: roleIds,
            conditions,
          })
        ),
      ]);

      const rowById = new Map(profileRows.map((r) => [r.id, r]));
      const bySlug = new Map<
        string,
        { statuses: Map<string | null, number>; label: string }
      >();
      for (const c of [...podKindCounts, ...wsKindCounts, ...roleCounts]) {
        const row = rowById.get(c.profileId);
        if (!row || c.count === 0) continue;
        let entry = bySlug.get(row.slug);
        if (!entry) {
          entry = { statuses: new Map(), label: row.displayName };
          bySlug.set(row.slug, entry);
        }
        entry.statuses.set(
          c.status,
          (entry.statuses.get(c.status) ?? 0) + c.count
        );
      }

      // One resolution per slug that has things, in parallel.
      const resolved = await Promise.all(
        [...bySlug.keys()].map(async (slug) => {
          try {
            return [
              slug,
              await resolveProfileLifecycle(slug, lensWorkspaceId),
            ] as const;
          } catch (err) {
            // Undeclared = not a pipeline (a fact). Anything else is a failure.
            if (err instanceof TRPCError && err.code === "PRECONDITION_FAILED")
              return [slug, null] as const;
            throw err;
          }
        })
      );
      const out: LifecycleSummaryWire[] = [];
      for (const [slug, p] of resolved) {
        const entry = bySlug.get(slug);
        if (!p || !entry) continue;
        const terminal = new Set(
          p.lifecycle.options
            .filter((o) => isTerminalLifecycleCategory(o.category))
            .map((o) => o.key)
        );
        let live = 0;
        let total = 0;
        for (const [status, n] of entry.statuses) {
          total += n;
          if (status === null || !terminal.has(status)) live += n;
        }
        if (live === 0) continue;
        out.push({
          profileSlug: slug,
          profileKind: p.profileKind,
          label: entry.label,
          live,
          total,
        });
      }
      return out.sort(
        (a, b) => b.live - a.live || a.label.localeCompare(b.label)
      );
    }),
});
