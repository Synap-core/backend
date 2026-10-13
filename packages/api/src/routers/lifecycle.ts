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
 * Grouping is THE ONE status grouping (`services/lifecycle/status-groups.ts`, shared with
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
} from "@synap/database";
import { profiles } from "@synap/database/schema";
import {
  LIFECYCLE_CATEGORIES,
  isTerminalLifecycleCategory,
  type LifecycleOption,
  UNCLASSIFIED_STATUS,
} from "@synap-core/types/lifecycle";
import {
  resolveBoardLens,
  resolveProfileLifecycle,
  toLifecycleWire,
} from "../services/lifecycle/board-lens.js";
import { readHome, readMoving } from "../services/lifecycle/homes.js";
import { countNeedsYouByScope } from "./signals.js";
import { listEnabledWorkers } from "../services/playbooks/workers.js";
import { loadWorkedBy } from "../services/lifecycle/worked-by.js";
import { loadCardFaces } from "../services/lifecycle/card-face.js";
import { rosterReadFor } from "../access/session-visibility.js";
import {
  countStuckThings,
  countTerminalEntriesByBucket,
  countThingsByProfileAndStatus,
  groupThingsByStatus,
  kindVisibilityConditions,
  pageThingsInColumn,
  roleVisibilityConditions,
} from "../services/lifecycle/status-groups.js";

/** W17: below this many LIVE things a pipeline defaults to a list. */
export const BOARD_LIST_THRESHOLD = 10;

const categorySchema = z.enum(LIFECYCLE_CATEGORIES);

const lifecycleOptionWire = z.object({
  key: z.string(),
  label: z.string(),
  category: categorySchema,
  tone: z.string(),
  humanOnly: z.boolean(),
  /**
   * Days in this option before a thing is stuck; absent = no stuck rule.
   * Optional (not nullable) so the wire option IS `@synap-core/types`
   * `LifecycleOption` — surfaces assign one to the other.
   */
  stuckAfterDays: z.number().optional(),
});

const lifecycleWire = z.object({
  profileSlug: z.string(),
  profileKind: z.enum(["kind", "role"]),
  property: z.string(),
  options: z.array(lifecycleOptionWire),
});

const workedByWire = z.object({
  sessionId: z.string(),
  /** `worker` = an automation's session (a stage worker), else a person's/agent's session. */
  kind: z.enum(["session", "worker"]),
  /** Working RIGHT NOW (`isSessionWorkingNow`, the rail's "Working now" rule). */
  live: z.boolean(),
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
  /**
   * In its column longer than the option's `stuckAfterDays` (time in column
   * from `since`). Always false in a column with no stuck rule — and in the
   * unclassified column, which has no option.
   */
  stuck: z.boolean(),
  /**
   * Who is on this thing — open sessions on it (its subject, or a worker
   * targeting it), live first, at most `WORKED_BY_CAP`. Present only when the
   * board was read with `workedBy: true`; `[]` = nobody on it.
   */
  workedBy: z.array(workedByWire).optional(),
  /**
   * The thing's card face — its kind and properties, what the pipeline card
   * builds the kind card model's visual + ONE field from (surfaces WP.9).
   * Present only when the board was read with `card: true`.
   */
  card: z
    .object({
      profileSlug: z.string().nullable(),
      properties: z.record(z.string(), z.unknown()),
    })
    .optional(),
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
  /**
   * Things in this column past its option's `stuckAfterDays` — the WHOLE
   * column, not just the listed items. Null = the option declares no stuck
   * rule (a surface omits the count; it is not zero).
   */
  stuck: z.number().nullable(),
  /**
   * The unclassified column only: how many of its things have NO status at
   * all (never set), as opposed to a value no option declares (homes X2).
   */
  unset: z.number().optional(),
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

/** A (space, produced kind) on a home — `services/lifecycle/homes.ts`. */
const producedKindWire = z.object({
  profileSlug: z.string(),
  label: z.string(),
  plural: z.string(),
  /** Open + active + paused + unclassified things (the board's `live`). */
  live: z.number(),
  /** Every visible thing, all statuses, unwindowed. */
  total: z.number(),
  /** Things that entered a `done` option within `windowDays`. */
  doneWindowed: z.number(),
  windowDays: z.number(),
  /**
   * The pipeline bar: declared options in order (done/lost counted within the
   * window, like the board), then `__unclassified` when it holds any.
   */
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      category: categorySchema.nullable(),
      count: z.number(),
      /**
       * The unclassified column only: how many of its things have NO status at
       * all (never set), as opposed to a value no option declares (homes X2).
       */
      unset: z.number().optional(),
    })
  ),
  /** `signals.countByProfile` for this space + kind; null = that read failed. */
  needsYou: z.number().nullable(),
  /** Live things someone is on (the board's workedBy rule); null = read failed. */
  beingWorked: z.number().nullable(),
  /** The ONE thing worth naming: needs_you → being_worked → stuck → recent. */
  headline: z
    .object({
      entityId: z.string(),
      title: z.string().nullable(),
      status: z.string().nullable(),
      reason: z.enum(["needs_you", "being_worked", "stuck", "recent"]),
    })
    .nullable(),
});

const spaceIntentWire = z.object({
  workspaceId: z.string(),
  name: z.string(),
  /** The purpose word ("Product" → "Product · Dev"); the name when inferred. */
  label: z.string(),
  /** `template` = settings.intent; `inferred` = read-time, never stored. */
  source: z.enum(["template", "inferred"]),
  /** `library` = produces nothing (the template's word, or nothing inferred). */
  kind: z.enum(["producing", "library"]),
  produces: z.array(producedKindWire),
});

const homeWire = z.object({
  /** Producing spaces first (most live things first), then libraries by name. */
  spaces: z.array(spaceIntentWire),
  needsYou: z.object({
    /** `signals.count` on the caller's floor (narrowed to the project). */
    total: z.number().nullable(),
    bySpace: z.array(
      z.object({ workspaceId: z.string(), count: z.number().nullable() })
    ),
    /**
     * Needs-you that lives in NO space: no-workspace rows plus unfinished
     * captures. null = not measured, never 0. total ≠ Σ bySpace + podLevel:
     * a cluster spanning two spaces counts in both, and a space the home does
     * not list (a system or agent space) counts in neither.
     */
    podLevel: z.number().nullable(),
  }),
});

const movingLineWire = z.object({
  sessionId: z.string(),
  label: z.string(),
  /** The agent on it, by name; absent when none is named. */
  actor: z.string().optional(),
  /** Working RIGHT NOW (`isSessionWorkingNow`). */
  live: z.boolean(),
  /** The session holds a deliverable owed by you (THE needs-you predicate). */
  asksYou: z.boolean(),
  since: z.string(),
});

const movingWire = z.object({
  /** Most urgent first: asks you, then live, then the longest-running. */
  items: z.array(
    z.object({
      entityId: z.string(),
      title: z.string().nullable(),
      profileSlug: z.string().nullable(),
      workspaceId: z.string().nullable(),
      status: z.string().nullable(),
      category: z.string().nullable(),
      work: z.array(
        movingLineWire.extend({
          /** `worker` = an automation's session; `scheduled` = a scheduled prep. */
          kind: z.enum(["session", "worker", "scheduled"]),
        })
      ),
    })
  ),
  /**
   * Open work sessions on NO thing (no subject, no worker target) — "No thing
   * yet · attach one". Asks you first, then live, then most recently moved;
   * capped (`UNATTACHED_CAP`), narrowed by the session's own space / project.
   */
  unattached: z.array(
    movingLineWire.extend({
      /** The SESSION's own space; null = none. */
      workspaceId: z.string().nullable(),
    })
  ),
});

export type LifecycleWire = z.infer<typeof lifecycleWire>;
export type LifecycleHomeWire = z.infer<typeof homeWire>;
export type LifecycleMovingWire = z.infer<typeof movingWire>;

/**
 * COMPILE-TIME PIN: a wire option IS a `@synap-core/types` `LifecycleOption`
 * (surfaces hand one to code typed by the other). A wire field that drifts
 * from the model — e.g. `stuckAfterDays: number | null` against the model's
 * `stuckAfterDays?: number` — stops this build, not a surface's.
 */
export const _wireOptionIsLifecycleOption = (
  o: LifecycleWire["options"][number]
): LifecycleOption => o;
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

/** The lens every pipeline read takes — `board` and `throughput` alike. */
const boardLensInput = {
  /** A kind (grouped by `entities.status`) or a role (by facet status). */
  profileSlug: z.string().min(1),
  projectId: z.string().uuid().optional(),
  /** The track's project (L7 will add its enabled workers). */
  trackId: z.string().uuid().optional(),
  /** `undefined` → the active workspace header; `null` → pod-wide only. */
  workspaceId: z.string().uuid().nullable().optional(),
};

const THROUGHPUT_BUCKETS = ["day", "week", "month"] as const;

/** The UTC start of the bucket holding `at` (`date_trunc` semantics: weeks start Monday). */
export function throughputBucketStart(
  at: Date,
  bucket: (typeof THROUGHPUT_BUCKETS)[number]
): Date {
  const d = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  );
  if (bucket === "week")
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (bucket === "month") d.setUTCDate(1);
  return d;
}

/** The start of the bucket `n` buckets before `start` (n ≥ 0). */
function bucketsBefore(
  start: Date,
  bucket: (typeof THROUGHPUT_BUCKETS)[number],
  n: number
): Date {
  const d = new Date(start);
  if (bucket === "day") d.setUTCDate(d.getUTCDate() - n);
  if (bucket === "week") d.setUTCDate(d.getUTCDate() - 7 * n);
  if (bucket === "month") d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

const throughputWire = z.object({
  bucket: z.enum(THROUGHPUT_BUCKETS),
  /** The first bucket's start — the read counts entries at or after it. */
  since: z.string(),
  /**
   * EVERY bucket from `since` to the current one, oldest first, zeros
   * included — a fixed-length series, never a sparse one a client must pad.
   */
  buckets: z.array(
    z.object({
      bucketStart: z.string(),
      /** Things that entered a `done` option in the bucket. */
      done: z.number(),
      /** Things that entered a `lost` option in the bucket. */
      lost: z.number(),
    })
  ),
});

export type LifecycleThroughputWire = z.infer<typeof throughputWire>;

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
        ...boardLensInput,
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
        /**
         * Also project `workedBy` on every returned item (design C's "being
         * worked" mark): ONE batched read for the page (`loadWorkedBy`).
         * Opt-in — the same pattern as `focusSessions.list({ nextMove })`.
         */
        workedBy: z.boolean().optional(),
        /**
         * Also project each item's card face (`card`: its kind + properties)
         * so the pipeline card can draw the kind card's visual and ONE
         * field. Opt-in, ONE batched read for the page (`loadCardFaces`).
         */
        card: z.boolean().optional(),
      })
    )
    .output(boardWire)
    .query(async ({ input, ctx }) => {
      const { projectId, lifecycle, conditions, subject } =
        await resolveBoardLens(input, ctx);

      const since = new Date(Date.now() - input.window.days * 86_400_000);
      const terminalKeys = lifecycle.options
        .filter((o) => isTerminalLifecycleCategory(o.category))
        .map((o) => o.key);
      // STUCK: the option's own rule (declared once, on the lifecycle), never
      // a client-side guess. Terminal options never carry one.
      const stuckDays = new Map(
        lifecycle.options.flatMap((o) =>
          o.stuckAfterDays !== undefined &&
          !isTerminalLifecycleCategory(o.category)
            ? [[o.key, o.stuckAfterDays] as const]
            : []
        )
      );
      const now = Date.now();
      const stuckOf = (status: string | null, sinceIso: string): boolean => {
        const days = status === null ? undefined : stuckDays.get(status);
        return (
          days !== undefined && Date.parse(sinceIso) < now - days * 86_400_000
        );
      };
      const [groups, allCounts, stuckCounts] = await Promise.all([
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
        countStuckThings({
          subject,
          conditions,
          rules: [...stuckDays].map(([status, days]) => ({ status, days })),
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
            items: (g?.items ?? []).map((i) => ({
              ...i,
              status: o.key,
              stuck: stuckOf(o.key, i.since),
            })),
            windowed: isTerminalLifecycleCategory(o.category),
            stuck: stuckDays.has(o.key) ? (stuckCounts.get(o.key) ?? 0) : null,
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
          key: UNCLASSIFIED_STATUS,
          category: null,
          count: stray.reduce((n, g) => n + g.count, 0),
          unset: stray
            .filter((g) => g.status === null)
            .reduce((n, g) => n + g.count, 0),
          items: stray
            .flatMap((g) =>
              g.items.map((i) => ({ ...i, status: g.status, stuck: false }))
            )
            .sort((a, b) => a.since.localeCompare(b.since))
            .slice(0, input.firstN),
          windowed: false,
          stuck: null,
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
          (input.column === UNCLASSIFIED_STATUS
            ? {
                key: UNCLASSIFIED_STATUS,
                category: null,
                count: 0,
                items: [],
                windowed: false,
                stuck: null,
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
            col.key === UNCLASSIFIED_STATUS
              ? { outside: [...declared] }
              : { statuses: [col.key] },
          offset,
          limit: input.limit,
        });
        shownColumns = [
          {
            ...col,
            items: page.items.map((i) => ({
              ...i,
              stuck:
                col.key === UNCLASSIFIED_STATUS
                  ? false
                  : stuckOf(col.key, i.since),
            })),
          },
        ];
        nextCursor = page.hasMore ? String(offset + input.limit) : null;
      }

      if (input.workedBy) {
        const marks = await loadWorkedBy(
          { userId: ctx.userId, roster: rosterReadFor(ctx) },
          shownColumns.flatMap((c) => c.items.map((i) => i.id))
        );
        shownColumns = shownColumns.map((c) => ({
          ...c,
          items: c.items.map((i) => ({
            ...i,
            workedBy: marks.get(i.id) ?? [],
          })),
        }));
      }

      if (input.card) {
        const faces = await loadCardFaces(
          shownColumns.flatMap((c) => c.items.map((i) => i.id))
        );
        shownColumns = shownColumns.map((c) => ({
          ...c,
          items: c.items.map((i) => {
            const face = faces.get(i.id);
            return face ? { ...i, card: face } : i;
          }),
        }));
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
   * THROUGHPUT — things that entered a done / lost option, per bucket, over
   * the board's own lens (`resolveBoardLens`) and visible things
   * (`countTerminalEntriesByBucket`, read from the transition log). The
   * goal line of an intent surface; the TARGET is stored config, not API.
   * `period.count` buckets ending with the current one, zeros included.
   */
  throughput: podProcedure
    .input(
      z.object({
        ...boardLensInput,
        period: z
          .object({
            bucket: z.enum(THROUGHPUT_BUCKETS),
            count: z.number().int().min(1).max(366),
          })
          .default({ bucket: "week", count: 12 }),
      })
    )
    .output(throughputWire)
    .query(async ({ input, ctx }) => {
      const { conditions, subject } = await resolveBoardLens(input, ctx);
      const { bucket, count } = input.period;
      const current = throughputBucketStart(new Date(), bucket);
      const since = bucketsBefore(current, bucket, count - 1);
      const rows = await countTerminalEntriesByBucket({
        subject,
        conditions,
        since,
        bucket,
      });
      const byStart = new Map(rows.map((r) => [r.bucketStart, r]));
      const buckets = Array.from({ length: count }, (_, i) => {
        const start = bucketsBefore(current, bucket, count - 1 - i);
        const key = start.toISOString();
        const r = byStart.get(key);
        return { bucketStart: key, done: r?.done ?? 0, lost: r?.lost ?? 0 };
      });
      return { bucket, since: since.toISOString(), buckets };
    }),

  /**
   * HOME (object-first homes): every space the caller sees, with what it
   * PRODUCES — the template's `settings.intent`, else one inferred at read
   * time — and per produced kind its pipeline in one line, needs-you,
   * being-worked and a headline thing. `projectId` narrows every count to
   * the project. See `services/lifecycle/homes.ts`.
   */
  home: podProcedure
    .input(z.object({ projectId: z.string().uuid().optional() }).default({}))
    .output(homeWire)
    .query(({ input, ctx }) =>
      readHome(ctx, input, (scopes) => countNeedsYouByScope(ctx, scopes))
    ),

  /**
   * MOVING NOW: the things with open work on them (a session on it, an
   * in-flight worker targeting it, a scheduled prep), the work under each,
   * most urgent first. Narrowed to the thing's space and/or a project.
   */
  moving: podProcedure
    .input(
      z
        .object({
          projectId: z.string().uuid().optional(),
          workspaceId: z.string().uuid().optional(),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .default({ limit: 30 })
    )
    .output(movingWire)
    .query(({ input, ctx }) => readMoving(ctx, input)),

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
