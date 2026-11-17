/**
 * WHERE ITS WORK STANDS — `statusOf`'s `include: ["work"]` (plan 7d71ddcc §2
 * "One read", W4). For each subject asked about, the sessions and runs on it,
 * each projected by `workItemOf` (`status-work-model.ts`) from THE
 * continuation packet (`projectContinuationPacket`, the one session read every
 * session door returns) and its newest playbook run.
 *
 * Which sessions:
 *   - a SESSION (or a run, through its session): itself;
 *   - a THING: the sessions ON it, by THE "on" predicate the session list and
 *     the board share (`sessionSubjectWhere`: its subject, or a worker that
 *     targets it), ended ones included (a run that stopped early must show),
 *     receipts left out; open first, then most recently moved, at most
 *     {@link STATUS_OF_WORK_MAX} (`truncated` says more exist);
 *   - a GOAL: the sessions filed in it (`track_id`), the same order and cap.
 * Every session is read under THE statusOf session floor
 * (`sessionStatusFloor`): a session the reader cannot open is never listed.
 *
 * A thing has no packet of its own: its work is composed from the packets of
 * the sessions on it. One packet per listed session (the cap bounds it), each
 * read once even when a session is on two asked things.
 *
 * WHAT THE READER MAY DO on each item is decided here with the doors' OWN
 * checks, never re-derived, so a button and its door cannot disagree:
 *   - `continue.canAct`: `continueCheck`, every rung the Continue door
 *     refuses on (the grant only ASKED here, `grantDeniedKey`: a read records
 *     no denial);
 *   - a gate's `canReview`: `resolveViewerReviewVerdicts`, the verdict
 *     `proposals.list` and `proposals.get` stamp as `viewerCanReview` (the
 *     approve door's ladder).
 * With no `viewer` the reader may do nothing (both `false`). A check that
 * fails to read offers nothing, never a button the door might refuse.
 *
 * THROWS when the session lists cannot be read; the caller answers the part
 * `unavailable`. A packet or a run read that fails makes only ITS sections
 * `unavailable`, never the whole part.
 */
import {
  and,
  asc,
  db,
  desc,
  drizzleSql,
  eq,
  focusSessions,
  getRequestGrant,
  inArray,
  listHolds,
  playbookRuns,
  proposals,
  type CurrentHold,
} from "@synap/database";
import type { FocusSession } from "@synap/database/schema";
import {
  STATUS_OF_WORK_MAX,
  type StatusOfWork,
  type StatusOfWorkItem,
  type StatusOfWorkUnavailable,
} from "@synap-core/types/units";
import {
  sessionStatusCategory,
  TERMINAL_SESSION_STATUSES,
} from "@synap-core/types/focus-sessions";
import type { RecordedHold } from "@synap-core/types/lifecycle";
import { createLogger } from "@synap-core/core";
import { openLink } from "../../utils/deep-links.js";
import { sessionStatusFloor } from "./status-floor.js";
import { sessionSubjectWhere } from "../focus-sessions/session-subject-where.js";
import {
  notReceiptWhere,
  projectSessionKind,
} from "../focus-sessions/session-kind.js";
import type { ContinuationPacket } from "../focus-sessions/continuation-packet.js";
import { workItemOf, type WorkRunRow } from "./status-work-model.js";
import { grantDeniedKey } from "../../utils/grant-write-check.js";
import { continueCheck } from "../focus-sessions/continue-run.js";

const logger = createLogger({ module: "status-work" });

/** What the work part is asked for, keyed by the answer's id. */
export interface StatusWorkQuestion {
  /** Sessions asked about themselves: answer id → session id. */
  sessions: ReadonlyArray<{ answerId: string; sessionId: string }>;
  things: readonly string[];
  goals: readonly string[];
}

/**
 * WHO READS, as the door knows them: the agent acting (`ctx.agentUserId`;
 * `null` = the person themselves) and the door's session-roster semantics
 * (`rosterReadFor(ctx)`), the two facts the Continue and approve doors decide
 * on beyond the user.
 */
export interface StatusViewer {
  agentUserId: string | null;
  roster: boolean;
}

type Listed = { row: FocusSession; on: StatusOfWorkItem["on"] };

/** Open sessions first, then the most recently moved. */
const openFirst = () => [
  asc(
    drizzleSql`(${focusSessions.status} IN (${drizzleSql.join(
      TERMINAL_SESSION_STATUSES.map((s) => drizzleSql`${s}`),
      drizzleSql`, `
    )}))`
  ),
  desc(focusSessions.updatedAt),
  desc(focusSessions.id),
];

/** The newest run of each session, one read (`DISTINCT ON`). THROWS. */
async function newestRuns(
  sessionIds: readonly string[]
): Promise<Map<string, WorkRunRow>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([playbookRuns.sessionId], {
      sessionId: playbookRuns.sessionId,
      id: playbookRuns.id,
      status: playbookRuns.status,
      stopReason: playbookRuns.stopReason,
      error: playbookRuns.error,
      startedAt: playbookRuns.startedAt,
      completedAt: playbookRuns.completedAt,
    })
    .from(playbookRuns)
    .where(inArray(playbookRuns.sessionId, [...sessionIds]))
    .orderBy(
      playbookRuns.sessionId,
      desc(playbookRuns.startedAt),
      desc(playbookRuns.id)
    );
  return new Map(
    rows.flatMap((r) =>
      r.sessionId
        ? [
            [
              r.sessionId,
              {
                id: r.id,
                status: r.status,
                stopReason: r.stopReason ?? null,
                error: r.error ?? null,
                startedAt: r.startedAt,
                completedAt: r.completedAt ?? null,
              },
            ] as const,
          ]
        : []
    )
  );
}

/** The work on each asked subject, by answer id. THROWS on a failed list. */
export async function readStatusWork(
  userId: string,
  q: StatusWorkQuestion,
  viewer?: StatusViewer
): Promise<Map<string, StatusOfWork>> {
  const floor = sessionStatusFloor(userId);
  const listedFor = new Map<string, { items: Listed[]; truncated: boolean }>();

  const selfIds = [...new Set(q.sessions.map((s) => s.sessionId))];
  const [selfRows, thingLists, goalLists] = await Promise.all([
    selfIds.length
      ? db
          .select()
          .from(focusSessions)
          .where(and(inArray(focusSessions.id, selfIds), floor))
      : Promise.resolve([]),
    Promise.all(
      q.things.map((id) =>
        db
          .select()
          .from(focusSessions)
          .where(
            and(
              floor,
              sessionSubjectWhere({ kind: "entities", entityIds: [id] }),
              notReceiptWhere()
            )
          )
          .orderBy(...openFirst())
          .limit(STATUS_OF_WORK_MAX + 1)
      )
    ),
    Promise.all(
      q.goals.map((id) =>
        db
          .select()
          .from(focusSessions)
          .where(and(floor, eq(focusSessions.trackId, id), notReceiptWhere()))
          .orderBy(...openFirst())
          .limit(STATUS_OF_WORK_MAX + 1)
      )
    ),
  ]);

  const byId = new Map(selfRows.map((r) => [r.id, r as FocusSession]));
  for (const s of q.sessions) {
    const row = byId.get(s.sessionId);
    listedFor.set(s.answerId, {
      items: row ? [{ row, on: "self" }] : [],
      truncated: false,
    });
  }
  q.things.forEach((id, i) => {
    const rows = thingLists[i]! as FocusSession[];
    listedFor.set(id, {
      items: rows.slice(0, STATUS_OF_WORK_MAX).map((row) => ({
        row,
        on: row.subjectEntityId === id ? "subject" : "target",
      })),
      truncated: rows.length > STATUS_OF_WORK_MAX,
    });
  });
  q.goals.forEach((id, i) => {
    const rows = goalLists[i]! as FocusSession[];
    listedFor.set(id, {
      items: rows
        .slice(0, STATUS_OF_WORK_MAX)
        .map((row) => ({ row, on: "goal" as const })),
      truncated: rows.length > STATUS_OF_WORK_MAX,
    });
  });

  // Every listed session once: its packet, its newest run, its hold.
  const sessions = new Map<string, FocusSession>();
  for (const l of listedFor.values()) {
    for (const { row } of l.items) sessions.set(row.id, row);
  }
  const ids = [...sessions.keys()];
  const { projectContinuationPacket } =
    await import("../focus-sessions/continuation-packet.js");
  const packets = new Map<
    string,
    Promise<ContinuationPacket | { failed: string }>
  >(
    [...sessions.values()].map((row) => [
      row.id,
      projectContinuationPacket(row, { userId, ownerDeploys: "own" }).catch(
        (err: unknown) => {
          logger.warn(
            { err, sessionId: row.id },
            "statusOf work: a session's packet could not be read"
          );
          return { failed: "Where this session stands could not be read." };
        }
      ),
    ])
  );
  const runs = newestRuns(ids).catch((err: unknown) => {
    logger.warn({ err }, "statusOf work: the sessions' runs could not be read");
    return null;
  });
  const paused = ids.filter(
    (id) => sessionStatusCategory(sessions.get(id)!.status) === "paused"
  );
  const holds = (
    paused.length
      ? listHolds(db, {
          subjects: paused.map((id) => ({
            subjectType: "focus_session" as const,
            subjectId: id,
          })),
        }).then(
          (rows) =>
            new Map(
              rows
                .filter((h) => h.facetId == null)
                .map((h): [string, CurrentHold] => [h.subjectId, h])
            )
        )
      : Promise.resolve(new Map<string, CurrentHold>())
  ).catch((err: unknown) => {
    logger.warn(
      { err },
      "statusOf work: the sessions' holds could not be read"
    );
    return null;
  });

  const [runRows, holdRows, packetOf] = await Promise.all([
    runs,
    holds,
    Promise.all(
      ids.map(async (id) => [id, await packets.get(id)!] as const)
    ).then((pairs) => new Map(pairs)),
  ]);
  const [mayContinue, mayReview] = await Promise.all([
    viewer && runRows
      ? continuableBy(userId, viewer, [...sessions.values()], runRows)
      : Promise.resolve(new Set<string>()),
    viewer
      ? reviewableBy(userId, viewer, [...packetOf.values()])
      : Promise.resolve(new Set<string>()),
  ]);
  const items = new Map<string, StatusOfWorkItem>();
  await Promise.all(
    ids.map(async (id) => {
      const row = sessions.get(id)!;
      const packet = packetOf.get(id)!;
      const hold: RecordedHold | StatusOfWorkUnavailable | undefined =
        holdRows === null
          ? { status: "unavailable", reason: "Its hold could not be read." }
          : holdRows.get(id)?.hold;
      items.set(
        id,
        workItemOf({
          row: {
            id: row.id,
            title: row.title ?? null,
            goal: row.goal ?? null,
            status: row.status,
            playbookId: row.playbookId ?? null,
            channelId: row.channelId ?? null,
            stages: row.stages,
            currentStage: row.currentStage ?? null,
            closedAt: row.closedAt ?? null,
          },
          on: "self",
          kind: projectSessionKind(row),
          packet,
          run:
            runRows === null
              ? { failed: "Its run could not be read." }
              : (runRows.get(id) ?? null),
          ...(hold ? { hold } : {}),
          may: { continue: mayContinue.has(id), review: mayReview },
          link: openLink(id),
        })
      );
    })
  );

  const out = new Map<string, StatusOfWork>();
  for (const [answerId, l] of listedFor) {
    out.set(answerId, {
      items: l.items.map(({ row, on }) => ({ ...items.get(row.id)!, on })),
      truncated: l.truncated,
    });
  }
  return out;
}

/**
 * The sessions this reader may continue now: THE Continue door's check
 * (`continueCheck`), its grant rung only asked. A check that throws offers
 * nothing.
 */
async function continuableBy(
  userId: string,
  viewer: StatusViewer,
  rows: readonly FocusSession[],
  runs: ReadonlyMap<string, WorkRunRow>
): Promise<Set<string>> {
  const grant = getRequestGrant();
  const ok = await Promise.all(
    rows.map((session) =>
      continueCheck({
        session,
        run: runs.get(session.id) ?? null,
        userId,
        agentUserId: viewer.agentUserId,
        grantDenial: async (write) =>
          grant && (await grantDeniedKey(write, grant)) ? "denied" : null,
      }).then(
        (c) => c.ok,
        (err: unknown) => {
          logger.warn(
            { err, sessionId: session.id },
            "statusOf work: whether the reader may continue it could not be read"
          );
          return false;
        }
      )
    )
  );
  return new Set(rows.filter((_, i) => ok[i]).map((r) => r.id));
}

/**
 * The gate proposals this reader may decide now: every PENDING gate's
 * proposal, through the verdict `proposals.list` and `proposals.get` stamp
 * (`resolveViewerReviewVerdicts`, the approve door's ladder). A failed read
 * offers nothing.
 */
async function reviewableBy(
  userId: string,
  viewer: StatusViewer,
  packets: ReadonlyArray<ContinuationPacket | { failed: string }>
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      packets.flatMap((p) =>
        "failed" in p || p.gates.status !== "ok"
          ? []
          : p.gates.items.flatMap((g) =>
              g.state === "pending" && g.proposalId ? [g.proposalId] : []
            )
      )
    ),
  ];
  if (ids.length === 0) return new Set();
  try {
    const rows = await db
      .select({
        id: proposals.id,
        workspaceId: proposals.workspaceId,
        data: proposals.data,
        agentUserId: proposals.agentUserId,
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        sessionId: proposals.sessionId,
        proposalType: proposals.proposalType,
        projectId: proposals.projectId,
      })
      .from(proposals)
      .where(inArray(proposals.id, ids));
    const { resolveViewerReviewVerdicts } =
      await import("../../routers/proposals/review-authority.js");
    const verdicts = await resolveViewerReviewVerdicts({
      userId,
      roster: viewer.roster,
      actingAgentUserId: viewer.agentUserId,
      rows,
    });
    return new Set(
      [...verdicts].flatMap(([id, v]) => (v.viewerCanReview ? [id] : []))
    );
  } catch (err) {
    logger.warn(
      { err },
      "statusOf work: whether the reader may decide its gates could not be read"
    );
    return new Set();
  }
}
