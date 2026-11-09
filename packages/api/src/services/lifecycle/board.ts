/**
 * THE PIPELINE read — `lifecycle.board`'s body, moved out of
 * `routers/lifecycle.ts` so every read that draws a kind's or role's things
 * by status (the board door, the flow read `flow.of`,
 * `services/lifecycle/flow-read.ts`) calls ONE function: same lens
 * (`resolveBoardLens`), same grouping (`groupThingsByStatus`), same windows,
 * stuck rule, unclassified column, `workedBy` and card faces. Never a copy.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  isTerminalLifecycleCategory,
  UNCLASSIFIED_STATUS,
} from "@synap-core/types/lifecycle";
import type { LifecycleBoardWire } from "../../routers/lifecycle.js";
import { rosterReadFor } from "../../access/session-visibility.js";
import { listEnabledWorkers } from "../playbooks/workers.js";
import { resolveBoardLens, type BoardLens } from "./board-lens.js";
import { loadCardFaces } from "./card-face.js";
import {
  countStuckThings,
  countThingsByProfileAndStatus,
  groupThingsByStatus,
  pageThingsInColumn,
  stuckAfterDaysOf,
} from "./status-groups.js";
import { loadWorkedBy } from "./worked-by.js";

/** W17: below this many LIVE things a pipeline defaults to a list. */
export const BOARD_LIST_THRESHOLD = 10;

/** A column page cursor is the offset into the column, as a string. */
function readCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor." });
  }
  return n;
}

/** The lens every pipeline read takes — `board`, `throughput` and `flow.of`. */
export const boardLensInput = {
  /** A kind (grouped by `entities.status`) or a role (by facet status). */
  profileSlug: z.string().min(1),
  projectId: z.string().uuid().optional(),
  /** The track's project (L7 will add its enabled workers). */
  trackId: z.string().uuid().optional(),
  /** `undefined` → the active workspace header; `null` → pod-wide only. */
  workspaceId: z.string().uuid().nullable().optional(),
};

/** `lifecycle.board`'s input. */
export const boardInput = z.object({
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
});

export type BoardInput = z.output<typeof boardInput>;

/** Who reads the board: the tRPC context fields the reads below take. */
export interface BoardReader {
  userId: string;
  workspaceId?: string | null;
  agentUserId?: string | null;
  isHubProtocol?: boolean;
}

/**
 * The board of a kind or role: things grouped by status column, options in
 * declared order, done/lost windowed, values no option declares in ONE
 * `__unclassified` column. THROWS on a failed read (never empty columns).
 */
export async function readBoard(
  input: BoardInput,
  ctx: BoardReader,
  /** The lens the caller already resolved for this input (no second read). */
  resolved?: BoardLens
): Promise<LifecycleBoardWire> {
  const { projectId, lifecycle, conditions, subject } =
    resolved ?? (await resolveBoardLens(input, ctx));

  const since = new Date(Date.now() - input.window.days * 86_400_000);
  const terminalKeys = lifecycle.options
    .filter((o) => isTerminalLifecycleCategory(o.category))
    .map((o) => o.key);
  // STUCK: the option's own rule (declared once, on the lifecycle), never
  // a client-side guess. Terminal options never carry one.
  const stuckDays = stuckAfterDaysOf(lifecycle.options);
  const now = Date.now();
  const stuckOf = (status: string | null, sinceIso: string): boolean => {
    const days = status === null ? undefined : stuckDays.get(status);
    return days !== undefined && Date.parse(sinceIso) < now - days * 86_400_000;
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
  const columns: LifecycleBoardWire["columns"] = lifecycle.options.map((o) => {
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
  });
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
    columns.filter((c) => c.category === cat).reduce((n, c) => n + c.count, 0);
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
            col.key === UNCLASSIFIED_STATUS ? false : stuckOf(col.key, i.since),
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
}
