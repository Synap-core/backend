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
  and,
  eq,
  drizzleSql,
  ProfileResolutionService,
  type EffectiveLifecycle,
} from "@synap/database";
import { playbooks } from "@synap/database/schema";
import {
  LIFECYCLE_CATEGORIES,
  isTerminalLifecycleCategory,
  lifecycleOptionLabel,
  lifecycleOptionTone,
} from "@synap-core/types/lifecycle";
import { assertKnownProfileSlug } from "../utils/assert-known-profile-slug.js";
import { getTrack } from "../services/tracks/tracks-service.js";
import {
  groupThingsByStatus,
  kindVisibilityConditions,
  roleVisibilityConditions,
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
  /** An active playbook with activators follows this lifecycle. */
  hasWorker: z.boolean(),
  /** W17: `list` below ~10 live things or with no worker. */
  suggestedShape: z.enum(["board", "list"]),
  window: z.object({ days: z.number(), since: z.string() }),
});

export type LifecycleWire = z.infer<typeof lifecycleWire>;
export type LifecycleBoardWire = z.infer<typeof boardWire>;

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
  const roleRows = rows.filter((r) => r.profileKind === "role");
  const chosen = roleRows.length > 0 ? roleRows : rows;
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
    profileKind: roleRows.length > 0 ? "role" : "kind",
    profileIds: chosen.map((r) => r.id),
    podScopeKind: chosen.some((r) => r.entityScope === "pod"),
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
      const [groups, allGroups] = await Promise.all([
        groupThingsByStatus({
          subject,
          conditions,
          firstN: input.firstN,
          order: "time_in_column",
          terminal: { statuses: terminalKeys, since },
        }),
        // `total` is unwindowed: the same set, counts only.
        groupThingsByStatus({
          subject,
          conditions,
          firstN: 0,
          order: "newest",
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
      const total = allGroups.reduce((n, g) => n + g.count, 0);
      const hasWorker = await hasActiveWorker(input.profileSlug);

      return {
        lifecycle,
        columns,
        doneWindowed: sumBy("done"),
        lostWindowed: sumBy("lost"),
        total,
        live,
        hasWorker,
        suggestedShape:
          live < BOARD_LIST_THRESHOLD || !hasWorker ? "list" : "board",
        window: { days: input.window.days, since: since.toISOString() },
      };
    }),
});

/**
 * A worker today = an ACTIVE playbook whose subject is this profile and that
 * declares activators (it starts itself on the lifecycle). L4 replaces this
 * with the lifecycle's enabled workers.
 */
async function hasActiveWorker(profileSlug: string): Promise<boolean> {
  const [row] = await db
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(
      and(
        eq(playbooks.status, "active"),
        drizzleSql`${playbooks.subjectProfile}->>'profileSlug' = ${profileSlug}`,
        drizzleSql`jsonb_array_length(coalesce(${playbooks.subjectProfile}->'activators', '[]'::jsonb)) > 0`
      )
    )
    .limit(1);
  return !!row;
}
