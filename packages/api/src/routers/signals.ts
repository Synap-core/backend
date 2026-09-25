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
 * `notifCenter.list`, `focusSessions.owed`, `events.read`) via `createCaller` — the established
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
import {
  buildProposalScopeConditions,
  resolveAutomationStepRunIds,
} from "./proposals/scope-conditions.js";
import { requireUserId } from "../utils/user-scoped.js";
import { proposalsRouter } from "./proposals.js";
import { notifCenterRouter } from "./notif-center.js";
import { focusSessionsRouter } from "./focus-sessions.js";
import { eventsRouter } from "./events.js";
import { extractProposalName } from "../services/proposals/fingerprint.js";
import {
  unionNeedsYou,
  pageNeedsYou,
  countNeedsYou,
  type NotificationSignalInput,
  type OwedSlotSignalInput,
  type Signal,
} from "../services/signals/needs-you-union.js";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { countProjectSessionsAwaitingReview } from "../services/projects/project-needs-you.js";

/** How many unread notifications are pulled before dedupe. A page, not a total —
 *  `truncated` reports when the cap was hit rather than hiding it. */
const NOTIFICATION_SCAN_LIMIT = 100;

/** How many owed slots the COUNT door pulls before it must call its number a
 *  floor. `focusSessions.owed` caps at 200; this is a page, not a total. */
const OWED_SCAN_LIMIT = 100;

/**
 * The workspace lens, translated for EVERY half of the union that resolves its
 * scope through `resolveScope` — today `notifCenter.list` AND
 * `focusSessions.owed`.
 *
 * `proposals.groups` treats an ABSENT `workspaceId` as the full user floor,
 * while `resolveScope` falls back to the active-workspace HEADER when the field
 * is absent. Left alone, the halves of one union speak different lenses: one
 * narrows to whatever workspace the client last activated while the others stay
 * pod-wide, and the tray claims "nothing needs you" with work waiting one lens
 * over. An explicit empty array is `resolveScope`'s "widen to the floor" value
 * and suppresses the header default, so absent → `[]` makes every half agree.
 *
 * This has shipped broken twice. Any new half of this union whose door calls
 * `resolveScope` MUST come through here — it is not optional, and it is not
 * per-door.
 */
export function floorLens(
  workspaceId: string | null | undefined
): string | null | string[] {
  return workspaceId === undefined ? [] : workspaceId;
}

const SignalScope = {
  /** Same three-state as `proposals.groups`/`list`: string = that workspace,
   *  null = pod-wide only, undefined = the full user floor. */
  workspaceId: z.string().nullish(),
  /**
   * NARROWING lenses — "what needs me / what happened INSIDE this container".
   *
   * All three are forwarded to the SAME predicate builder the proposals queue
   * uses (`buildProposalScopeConditions` + `resolveAutomationStepRunIds`), so a
   * scoped signal list can never admit a row the unscoped one would not. They
   * compose with `workspaceId` and with each other.
   */
  sessionId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  automationId: z.string().uuid().optional(),
};

/**
 * Is this call scoped to a CONTAINER (a session, project or automation) rather
 * than to the pod/workspace floor?
 *
 * It decides whether the notification half of the needs-you union participates:
 * `notifications` carries no session/project/automation column and
 * `notifCenter.list` exposes no such filter, so under a container scope the
 * union would silently mix "this session's proposals" with "every unread
 * notification you have" — a number that grows when nothing in the container
 * changed. A scoped needs-you is therefore PROPOSALS-ONLY, and says so, rather
 * than faking a lens the notification store cannot serve.
 */
function isContainerScoped(input: {
  sessionId?: string;
  projectId?: string;
  automationId?: string;
}): boolean {
  return !!(input.sessionId || input.projectId || input.automationId);
}

/**
 * Can the OWED half honour this scope?
 *
 * `focusSessions.owed` narrows on the two lenses `sessionScopeConditions`
 * applies — workspace and project — and on nothing else. A `sessionId` or
 * `automationId` scope has no corresponding predicate on `focus_sessions`, and
 * post-filtering a `limit`-capped read is precisely what `owed-outputs.ts`
 * exists to refuse (owed slots accumulate on OLD sessions, so a page-then-filter
 * pass under-reports silently). So under those two scopes the owed half is
 * SUPPRESSED, for the same reason and by the same rule the notification half is:
 * a container-scoped tray never mixes a narrowed population with an unnarrowed
 * one. A `projectId` scope, by contrast, IS narrowable, so owed slots do
 * participate there even though notifications cannot.
 */
function isOwedNarrowable(input: {
  sessionId?: string;
  automationId?: string;
}): boolean {
  return !input.sessionId && !input.automationId;
}

/**
 * Does the REVIEW half of THE needs-you rule participate? Only under a bare
 * PROJECT scope. "Sessions awaiting your review/close" is read over the
 * project's session set (`projectPathConditions`); a session/automation scope
 * has no such set, and a workspace lens cannot be expressed on it faithfully
 * (a NULL-workspace session belongs to the project but to no workspace), so
 * under those scopes the half is SUPPRESSED rather than guessed — the same rule
 * the notification and owed halves follow. The pod-wide badge does not count
 * it yet (see the report of 2026-09-25): no project, no path population.
 */
function isReviewCountable(input: {
  workspaceId?: string | null;
  sessionId?: string;
  projectId?: string;
  automationId?: string;
}): input is { projectId: string } {
  return (
    !!input.projectId &&
    input.workspaceId === undefined &&
    !input.sessionId &&
    !input.automationId
  );
}

/**
 * The body of `signals.count` — one function so `count` and `countByProject`
 * answer over the SAME population by construction (a rail badge must equal the
 * number its project's own page shows).
 *
 * THE needs-you rule (`@synap-core/types/units` `needs-you.ts`): owed slots +
 * pending decisions + sessions awaiting your review, summed by `needsYouTotal`
 * inside `countNeedsYou`. Items, not sessions — the count differs from a
 * per-row `tallyNeedsYou` in two stated ways: decisions are distinct CLUSTERS
 * (a re-filed identical proposal is one decision), and a project scope also
 * counts proposals filed on the project with no session (a decision owed with
 * no session to hang it on).
 *
 * DRAFTS NEVER COUNT (founder decision): an undecided agent draft is a
 * suggestion, not work that needs you. All three halves apply the ONE triage
 * rule the path uses (`triage.ts`): the review half by `needsYouReason`, the
 * owed half by `excludeDrafts` (`notTriagePendingWhere`), and the decisions
 * half by `excludeDraftSessions` (a proposal filed under a draft session) —
 * each in SQL, so drafts cannot eat a scan cap. `list`'s needs-you lens
 * passes the same two flags, so the tray and the badge agree.
 */
async function countSignals(
  // The object form of the caller context (never the lazy factory) — the
  // review half reads the caller's `userId` for its owner floor.
  ctx: Extract<
    Parameters<typeof proposalsRouter.createCaller>[0],
    { userId?: unknown }
  >,
  input: z.infer<z.ZodObject<typeof SignalScope>>
) {
  const scoped = isContainerScoped(input);
  const [groups, notifs, owed, review] = await Promise.all([
    proposalsRouter.createCaller(ctx).groups({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      automationId: input.automationId,
      status: "pending",
      excludeDraftSessions: true,
    }),
    scoped
      ? Promise.resolve({ notifications: [] })
      : notifCenterRouter.createCaller(ctx).list({
          workspaceId: floorLens(input.workspaceId),
          status: "unread",
          limit: NOTIFICATION_SCAN_LIMIT,
        }),
    // Same door, same lens, same suppression rule as `list` — the count and
    // the list must answer over ONE population or the badge disagrees with
    // the rows under it.
    isOwedNarrowable(input)
      ? focusSessionsRouter.createCaller(ctx).owed({
          workspaceId: floorLens(input.workspaceId),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          limit: OWED_SCAN_LIMIT,
          excludeDrafts: true,
        })
      : Promise.resolve([]),
    isReviewCountable(input)
      ? countProjectSessionsAwaitingReview({
          userId: requireUserId(ctx.userId),
          projectId: input.projectId,
        })
      : Promise.resolve({ review: 0, truncated: false }),
  ]);

  return countNeedsYou({
    distinctClusters: groups.distinct,
    clustersTruncated: groups.scanTruncated,
    clusters: groups.groups,
    notifications: notifs.notifications as NotificationSignalInput[],
    notificationsTruncated:
      notifs.notifications.length >= NOTIFICATION_SCAN_LIMIT,
    owedSlots: owed as OwedSlotSignalInput[],
    owedTruncated: owed.length >= OWED_SCAN_LIMIT,
    reviewSessions: review.review,
    reviewTruncated: review.truncated,
  });
}

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
        // Container-scoped → proposals only. See `isContainerScoped`.
        const scoped = isContainerScoped(input);
        const [groups, notifs, owed] = await Promise.all([
          proposalsRouter.createCaller(ctx).groups({
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            projectId: input.projectId,
            automationId: input.automationId,
            status: "pending",
            limit: input.limit,
            excludeDraftSessions: true,
          }),
          scoped
            ? Promise.resolve({ notifications: [] })
            : notifCenterRouter.createCaller(ctx).list({
                workspaceId: floorLens(input.workspaceId),
                status: "unread",
                limit: NOTIFICATION_SCAN_LIMIT,
              }),
          // The SAME door `focusSessions.owed` exposes, through `createCaller`
          // like the other two halves — so the owner floor and the lens
          // application (`sessionScopeConditions`) are the ones Wave A already
          // shipped, not a second derivation living in this file.
          isOwedNarrowable(input)
            ? focusSessionsRouter.createCaller(ctx).owed({
                workspaceId: floorLens(input.workspaceId),
                ...(input.projectId ? { projectId: input.projectId } : {}),
                limit: input.limit,
                excludeDrafts: true,
              })
            : Promise.resolve([]),
        ]);

        const signals = unionNeedsYou({
          clusters: groups.groups,
          notifications: notifs.notifications as NotificationSignalInput[],
          owedSlots: owed as OwedSlotSignalInput[],
        });
        // Paged through `pageNeedsYou`, never a bare slice: owed slots are an
        // unbounded, never-expiring source sitting FIRST, so one shared cap let
        // them evict the entire pending-proposal queue from the tray while the
        // badge went on counting it.
        return { signals: pageNeedsYou(signals, input.limit) };
      }

      // ── history: past events merged with decided proposals ──────────────
      const before = input.cursor ? new Date(input.cursor) : undefined;
      // `projectId` / `automationId` have no `events` column to narrow on, so
      // under those scopes the events half is SUPPRESSED rather than returned
      // unnarrowed beside a narrowed proposals half — an unfiltered pod-wide
      // feed labelled "this project" is worse than a shorter honest one. A
      // session scope does narrow, through `events.session_id`.
      const eventsNarrowable = !input.projectId && !input.automationId;
      const [events, decided] = await Promise.all([
        eventsNarrowable
          ? eventsRouter.createCaller(ctx).read({
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
              // The session lens reaches events through `events.session_id`
              // (migration 0241) — the column's first reader outside the graph
              // service.
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...(before ? { until: before } : {}),
            })
          : Promise.resolve([]),
        listDecidedProposals(ctx, input, input.limit, before),
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
   * non-proposal notifications + owed slots — plus `blocked`, the owed subset,
   * so a client can render "Needs you (needsYou)" with a BLOCKED-ONLY badge
   * from this one query. `truncated` is inherited from
   * `proposals.groups`.scanTruncated, the notification page cap and the owed
   * page cap — when true, the number is a FLOOR, and a caller must render it as
   * such (e.g. "99+") rather than as an exact total.
   *
   * Takes the SAME scope as `list`, and applies the SAME proposals-only rule
   * under a container scope — a badge that counted a container's proposals plus
   * every unread pod notification would be a number no surface could explain.
   * Every existing caller passes at most `workspaceId`. The pod-wide count is
   * NO LONGER byte-identical to before: it now includes owed slots, which is the
   * point — a deliverable blocked on you needed you and the badge did not say
   * so.
   *
   * The number ships WITH its parts: `decisions` (distinct pending clusters),
   * `notifications` (deduped unread), `blocked` (owed slots) and `review`
   * (sessions awaiting your review/close — project scope only, see
   * `isReviewCountable`), with
   * `needsYou === decisions + notifications + blocked + review`. A client reads
   * the part it needs; it never derives one by subtracting the others.
   *
   * ⚠️ Under a project scope `review` has no ROWS in `list` yet (it would need
   * a new `Signal` kind every tray renderer learns), so the project list is
   * shorter than the project count by exactly `review`.
   */
  count: protectedProcedure
    .input(z.object(SignalScope).default({}))
    .query(({ ctx, input }) => countSignals(ctx, input)),

  /**
   * `count` for SEVERAL projects in one round-trip — the desktop project rail
   * badges every project it shows at once.
   *
   * Deliberately `count` itself, called once per project: the badge on a rail
   * plate must equal the needs-you number that project's own page shows, and a
   * second, grouped predicate would be a fork of the one this router exists to
   * hold. Projects are few (the rail caps them), so the fan-out is bounded.
   * A project whose count FAILS is reported as such, never as zero.
   */
  countByProject: protectedProcedure
    .input(
      z.object({
        projectIds: z.array(z.string().uuid()).max(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const ids = [...new Set(input.projectIds)];
      const settled = await Promise.allSettled(
        ids.map((projectId) => countSignals(ctx, { projectId }))
      );
      return ids.map((projectId, i) => {
        const r = settled[i]!;
        return r.status === "fulfilled"
          ? { projectId, status: "ok" as const, count: r.value }
          : { projectId, status: "unavailable" as const };
      });
    }),
});

/**
 * Recently DECIDED proposals (approved / auto-approved / rejected / expired),
 * newest decision first. Access starts from the identical predicate
 * `proposals.list` and `proposals.groups` build: the `workspaceId` three-state,
 * defaulting to `proposalUserFloor` — LENS ∪ OWNERSHIP, not the bare
 * `userVisibleWhere` this comment used to name. History and the live queue must
 * answer over the SAME population, or a row visible in the queue vanishes from
 * the record of what happened to it.
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
  scope: {
    workspaceId?: string | null;
    sessionId?: string;
    projectId?: string;
    automationId?: string;
  },
  limit: number,
  before: Date | undefined
): Promise<Signal[]> {
  const userId = requireUserId(ctx.userId);
  // The SAME builder `proposals.list` and `proposals.groups` scope on, rather
  // than a third hand-rolled copy of the workspace three-state. History and the
  // queue must agree about what a user can see; three copies of a visibility
  // predicate is two chances to tighten one and forget the others. The
  // container lenses (session/project/automation) ride the same builder for the
  // same reason.
  const conditions = buildProposalScopeConditions(scope, userId);
  if (scope.automationId) {
    // `proposals` has no `automationId` column — the automation is reached
    // through `automation_step_runs`. An empty id list compiles to `false`, so
    // an automation with no runs yields an honest empty history.
    conditions.push(
      inArray(
        proposals.stepRunId,
        await resolveAutomationStepRunIds(scope.automationId)
      )
    );
  }
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
