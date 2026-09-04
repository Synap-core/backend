/**
 * Signals Router — ONE door, two lenses.
 *
 * Mounted as `trpc.signals.*` (NOT to be confused with the pre-existing
 * `trpc.signal.*` router, which is the inbound bridge/webhook door — a
 * different object entirely).
 *
 * WHY THIS EXISTS. "What needs me?" is currently answered by two independent
 * reads that count different things: the decisions tray reads pending proposals
 * and the bell reads unread notifications. Approving one proposal produces a
 * row in BOTH, so the two badges disagree by construction. This router is the
 * single door both surfaces switch to, so there is exactly ONE definition of
 * "needs you" and exactly ONE number behind both badges.
 *
 * IT ADDS NO ACCESS LOGIC AND NO NEW QUERIES for the pending lens. It calls the
 * existing doors through their own routers (`proposals.groups`,
 * `notifCenter.list`, `events.read`) via `createCaller` — the established
 * in-process reuse pattern here (`workspaces.ts`, `capture.ts`, `signal.ts`) —
 * so every predicate those doors enforce (the `userVisibleWhere` floor, the
 * editor+ gate on a named workspace, the notification user floor + the pod-wide
 * `IS NULL` fix from migration 0231) applies unchanged. A signal can never
 * expose a row the caller could not already read.
 *
 * The one query this file owns is the DECIDED-proposal half of the history
 * lens: `proposals.list` orders by `createdAt` and has no `expired` status, so
 * it cannot answer "recently decided, newest decision first". That read uses
 * `userVisibleWhere` directly — the same access predicate `list` and `groups`
 * both start from.
 *
 * The union/dedupe itself is pure and lives in
 * `../services/signals/needs-you-union.ts`, with its own unit tests.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { db, proposals, and, desc, inArray, drizzleSql } from "@synap/database";
import { ProposalStatus } from "@synap/database";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { buildProposalScopeConditions } from "./proposals/scope-conditions.js";
import { requireUserId } from "../utils/user-scoped.js";
import { proposalsRouter } from "./proposals.js";
import { notifCenterRouter } from "./notif-center.js";
import { eventsRouter } from "./events.js";
import { extractProposalName } from "../services/proposals/fingerprint.js";
import {
  unionNeedsYou,
  countNeedsYou,
  type NotificationSignalInput,
  type Signal,
} from "../services/signals/needs-you-union.js";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";

/** How many unread notifications are pulled before dedupe. A page, not a total —
 *  `truncated` reports when the cap was hit rather than hiding it. */
const NOTIFICATION_SCAN_LIMIT = 100;

/**
 * The workspace lens, translated for `notifCenter.list`.
 *
 * `proposals.groups` treats an ABSENT `workspaceId` as the full user floor,
 * while `notifCenter.list` (via `resolveScope`) falls back to the
 * active-workspace HEADER when the field is absent. Left alone, the two halves
 * of one union would speak different lenses. An explicit empty array is
 * `resolveScope`'s "widen to the floor" value and suppresses the header
 * default, so absent → `[]` makes both halves agree.
 */
function notificationLens(
  workspaceId: string | null | undefined
): string | null | string[] {
  return workspaceId === undefined ? [] : workspaceId;
}

const SignalScope = {
  /** Same three-state as `proposals.groups`/`list`: string = that workspace,
   *  null = pod-wide only, undefined = the full user floor. */
  workspaceId: z.string().nullish(),
};

export const signalsRouter = router({
  /**
   * The one read behind the decisions tray (`needs-you`) and the activity feed
   * (`history`). Both lenses return the SAME `Signal` shape.
   */
  list: protectedProcedure
    .input(
      z.object({
        ...SignalScope,
        lens: z.enum(["needs-you", "history"]).default("needs-you"),
        limit: z.number().min(1).max(100).default(50),
        /** History lens only: return signals strictly older than this instant. */
        cursor: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }): Promise<{ signals: Signal[] }> => {
      if (input.lens === "needs-you") {
        const [groups, notifs] = await Promise.all([
          proposalsRouter.createCaller(ctx).groups({
            workspaceId: input.workspaceId,
            status: "pending",
            limit: input.limit,
          }),
          notifCenterRouter.createCaller(ctx).list({
            workspaceId: notificationLens(input.workspaceId),
            status: "unread",
            limit: NOTIFICATION_SCAN_LIMIT,
          }),
        ]);

        const signals = unionNeedsYou({
          clusters: groups.groups,
          notifications: notifs.notifications as NotificationSignalInput[],
        });
        return { signals: signals.slice(0, input.limit) };
      }

      // ── history: past events merged with decided proposals ──────────────
      const before = input.cursor ? new Date(input.cursor) : undefined;
      const [events, decided] = await Promise.all([
        eventsRouter.createCaller(ctx).read({
          limit: input.limit,
          lean: true,
          // Same lens the proposals half uses. `read` takes a plain optional
          // string, not the three-state: a `null` workspaceId means "pod-wide
          // proposals", and events carry no pod-wide sibling — so null and
          // undefined both mean "do not narrow" here, and the two halves agree
          // wherever a concrete workspace is named.
          ...(typeof input.workspaceId === "string"
            ? { workspaceId: input.workspaceId }
            : {}),
          ...(before ? { until: before } : {}),
        }),
        listDecidedProposals(ctx, input.workspaceId, input.limit, before),
      ]);

      const eventSignals: Signal[] = events.map((e) => ({
        id: `event:${e.id}`,
        kind: "event" as const,
        // `humanizeToken` is the vocabulary SSOT's fallback for any raw token —
        // an event type is not in any label table, and must never leak verbatim.
        title: humanizeToken(e.type),
        count: 1,
        occurredAt: e.timestamp,
        target:
          e.subjectType && e.subjectId
            ? { kind: e.subjectType, id: e.subjectId }
            : null,
        category: "data",
      }));

      const merged = [...eventSignals, ...decided].sort(
        (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()
      );
      return { signals: merged.slice(0, input.limit) };
    }),

  /**
   * ONE number for both badges: distinct pending clusters + unread
   * non-proposal notifications. `truncated` is inherited from
   * `proposals.groups`.scanTruncated and the notification page cap — when true,
   * the number is a FLOOR, and a caller must render it as such (e.g. "99+")
   * rather than as an exact total.
   */
  count: protectedProcedure
    .input(z.object(SignalScope).default({}))
    .query(async ({ ctx, input }) => {
      const [groups, notifs] = await Promise.all([
        proposalsRouter.createCaller(ctx).groups({
          workspaceId: input.workspaceId,
          status: "pending",
        }),
        notifCenterRouter.createCaller(ctx).list({
          workspaceId: notificationLens(input.workspaceId),
          status: "unread",
          limit: NOTIFICATION_SCAN_LIMIT,
        }),
      ]);

      return countNeedsYou({
        distinctClusters: groups.distinct,
        clustersTruncated: groups.scanTruncated,
        clusters: groups.groups,
        notifications: notifs.notifications as NotificationSignalInput[],
        notificationsTruncated:
          notifs.notifications.length >= NOTIFICATION_SCAN_LIMIT,
      });
    }),
});

/**
 * Recently DECIDED proposals (approved / auto-approved / rejected / expired),
 * newest decision first. Access starts from the identical predicate
 * `proposals.list` and `proposals.groups` build: the `workspaceId` three-state,
 * defaulting to `userVisibleWhere`.
 *
 * Ordered by the DECISION time, not `createdAt`: history answers "what was
 * decided, and when" — a month-old proposal decided this morning belongs at the
 * top.
 *
 * The decision time is `coalesce(reviewedAt, updatedAt)`, NOT `reviewedAt`
 * alone. Expiry is a decision that no human made: `expireLapsedProposals`
 * writes `status` + `updatedAt` and deliberately leaves `reviewedAt` NULL,
 * because stamping a reviewer on a lapse would claim a review that never
 * happened. Filtering (and paging) on `reviewedAt` therefore dropped EVERY
 * expired row out of history — the sweeper's whole output was invisible.
 * `updatedAt` is NOT NULL on every row, so the coalesce is total and no decided
 * row can fall out.
 */
async function listDecidedProposals(
  ctx: { userId?: string | null },
  workspaceId: string | null | undefined,
  limit: number,
  before: Date | undefined
): Promise<Signal[]> {
  const userId = requireUserId(ctx.userId);
  // The SAME builder `proposals.list` and `proposals.groups` scope on, rather
  // than a third hand-rolled copy of the workspace three-state. History and the
  // queue must agree about what a user can see; three copies of a visibility
  // predicate is two chances to tighten one and forget the others.
  const conditions = buildProposalScopeConditions({ workspaceId }, userId);
  conditions.push(
    inArray(proposals.status, [
      ProposalStatus.APPROVED,
      ProposalStatus.AUTO_APPROVED,
      ProposalStatus.REJECTED,
      ProposalStatus.EXPIRED,
    ])
  );
  // The one expression the filter, the cursor, the projection and the ORDER BY
  // all use — three copies of a coalesce is how two of them end up disagreeing.
  const decidedAt = drizzleSql<Date>`coalesce(${proposals.reviewedAt}, ${proposals.updatedAt})`;
  if (before) conditions.push(drizzleSql`${decidedAt} < ${before}`);

  const rows = await db
    .select({
      id: proposals.id,
      proposalType: proposals.proposalType,
      targetType: proposals.targetType,
      status: proposals.status,
      data: proposals.data,
      decidedAt,
    })
    .from(proposals)
    .where(and(...conditions))
    .orderBy(desc(decidedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: `proposal:${r.id}`,
    kind: "decided-proposal" as const,
    // PAST mood: history says what already happened. Imperative ("Create
    // company Acme") on a decided row would describe an action still pending.
    title: buildObjectActionTitle({
      action: r.proposalType,
      objectKind: r.targetType,
      objectName: extractProposalName(r.data) ?? null,
      mood: "past",
    }),
    count: 1,
    occurredAt: r.decidedAt as Date,
    target: { kind: "proposal", id: r.id },
    category: "governance",
  }));
}
