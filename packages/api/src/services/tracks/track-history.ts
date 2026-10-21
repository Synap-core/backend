/**
 * TRACK HISTORY — everything that happened to ONE track, newest first
 * (`tracks.history`). Contract + grouping: `@synap-core/types/units`
 * (`TrackHistoryEvent`, `trackHistoryGroups`).
 *
 * ── THE HONEST SOURCE OF EACH KIND ──────────────────────────────────────────
 *   track_started, step_moved — `project_tracks.stage_history` (0274). It is
 *       AUTHORITATIVE for moves: the entry is appended in the same UPDATE as
 *       the stage, so an entry exists iff the move landed, with its mover.
 *       `track.stage_changed` is a side-effect fan-out (pg-boss), persisted
 *       nowhere — never a source.
 *   check_passed, check_held — the verdict stamped on that same entry
 *       (`TrackRepository.stampStageCheck`, U5). Moves made before the stamp
 *       carry none: a hold is then recovered from the pause's write receipt
 *       (below); a pass from then is simply not known, never guessed.
 *   paused, resumed, status_changed — the track's write receipts:
 *       `track.update.completed` events (every `project_tracks` write emits one
 *       carrying the row), read as a status sequence. A pause whose row holds
 *       `metadata.checkGate` is the check's hold, not a person's pause.
 *   session_started, session_closed — the track's sessions, through THE
 *       session read rule and the ledger's population (`workAndTrackedRunsWhere`);
 *       the close carries the session's graded contract (`computeSessionVerdict`).
 *       SESSION-KIND-LENS-EXEMPT: projects the track's sessions into history EVENTS, never a session row; the population is workAndTrackedRunsWhere (kind lens applied in SQL) and triage does not apply to history.
 *   decision_asked, decision_answered — proposals on the track's stage gates
 *       and in its readable sessions: pending = an open ask; decided by a
 *       PERSON (`reviewed_by`) = answered, with the reviewer's note.
 *
 * ACTORS are named HERE (`activityActorOf`), never by a client.
 * A FAILED source read THROWS — a partial history must not read as a quiet one.
 */

import {
  and,
  asc,
  desc,
  eq,
  getDb,
  inArray,
  isNotNull,
  or,
  drizzleSql,
  events,
  focusSessions,
  proposals,
  sessionEvaluations,
} from "@synap/database";
import {
  OPEN_SESSION_STATUSES,
  computeSessionVerdict,
  latestEvaluationPerCriterion,
  resolveSessionTitle,
  type EvaluationRowLike,
} from "@synap-core/types/focus-sessions";
import {
  readTrackStageHistory,
  type TrackHistoryEvent,
  type TrackHistoryWire,
} from "@synap-core/types/units";
import { readProposalReviewComments } from "@synap-core/types/proposals";
import type { ActivityActor } from "@synap-core/types/activity";
import { AccessContext, scopedDb } from "../../access/index.js";
import { workAndTrackedRunsWhere } from "../focus-sessions/session-list-conditions.js";
import { activityActorOf, loadActorRows } from "../activity/activity-actors.js";
import { TRACK_STAGE_GATE_TARGET_TYPE } from "../playbooks/stage-gate.js";
import { getTrack, type TrackActor } from "./tracks-service.js";

/** Rows read per source. Hitting it sets `truncated` — older rows exist. */
export const TRACK_HISTORY_SOURCE_CAP = 500;

const DECISION_STATUSES = [
  "approved",
  "rejected",
  "reverted",
  "approval_failed",
] as const;

const SYSTEM: ActivityActor = { kind: "system", id: null, name: null };

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/**
 * Who stands behind an event, before naming: the id, and whether the source
 * itself says an agent acted. Named in ONE batch at the end.
 */
type Unnamed<E> = E extends unknown
  ? Omit<E, "actor"> & { actor?: ActivityActor }
  : never;
interface Pending {
  event: Unnamed<TrackHistoryEvent>;
  actorId: string | null;
  isAgent: boolean;
}

/** `null` when the track is not visible to the caller (NOT_FOUND upstream). */
export async function readTrackHistory(
  trackId: string,
  actor: TrackActor
): Promise<TrackHistoryWire | null> {
  const track = await getTrack(trackId, actor);
  if (!track) return null;
  const db = await getDb();
  const cap = TRACK_HISTORY_SOURCE_CAP;
  let truncated = false;
  const out: Pending[] = [];

  // ── the stage timeline (moves + stamped check verdicts) ───────────────────
  const history = readTrackStageHistory(track.stageHistory);
  history.forEach((e, i) => {
    const base = { stageKey: e.stageKey, at: e.enteredAt, refs: {} };
    if (i === 0 && e.fromStage === null) {
      out.push({
        event: { ...base, id: `stage:${i}:1-start`, kind: "track_started" },
        actorId: e.actor || null,
        isAgent: false,
      });
    } else {
      out.push({
        event: {
          ...base,
          id: `stage:${i}:1-move`,
          kind: "step_moved",
          fromStage: e.fromStage,
        },
        actorId: e.actor || null,
        isAgent: false,
      });
    }
    if (e.check && e.fromStage) {
      // `2-check` sorts above `1-move` at the same instant: the check ran after.
      out.push({
        event: e.check.passed
          ? {
              ...base,
              id: `stage:${i}:2-check`,
              kind: "check_passed",
              fromStage: e.fromStage,
              actor: SYSTEM,
            }
          : {
              ...base,
              id: `stage:${i}:2-check`,
              kind: "check_held",
              fromStage: e.fromStage,
              failing: e.check.failing,
              reason: e.check.reason ?? null,
              actor: SYSTEM,
            },
        actorId: null,
        isAgent: false,
      });
    }
  });
  if (history.length === 0) {
    out.push({
      event: {
        id: "track:start",
        kind: "track_started",
        at: new Date(track.createdAt).toISOString(),
        stageKey: track.currentStage ?? null,
        refs: {},
      },
      actorId: track.userId,
      isAgent: false,
    });
  }

  const [receipts, sessions] = await Promise.all([
    db
      .select({
        id: events.id,
        at: events.timestamp,
        userId: events.userId,
        status: drizzleSql<string | null>`${events.data}->>'status'`,
        currentStage: drizzleSql<
          string | null
        >`${events.data}->>'currentStage'`,
        checkGate: drizzleSql<unknown>`${events.data}->'metadata'->'checkGate'`,
      })
      .from(events)
      .where(
        and(
          eq(events.subjectType, "track"),
          eq(events.subjectId, track.id),
          inArray(events.type, [
            "track.create.completed",
            "track.update.completed",
          ])
        )
      )
      .orderBy(asc(events.timestamp), asc(events.id))
      .limit(cap + 1),
    db
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        status: focusSessions.status,
        trackStage: focusSessions.trackStage,
        startedAt: focusSessions.startedAt,
        createdAt: focusSessions.createdAt,
        closedAt: focusSessions.closedAt,
        updatedAt: focusSessions.updatedAt,
        criteria: focusSessions.criteria,
        ownerId: focusSessions.userId,
        agentId: drizzleSql<
          string | null
        >`(${focusSessions.metadata}->>'agentUserId')`,
        origin: focusSessions.origin,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.trackId, track.id),
          scopedDb(AccessContext.from(actor)).predicate(focusSessions),
          workAndTrackedRunsWhere()
        )
      )
      .orderBy(desc(focusSessions.createdAt))
      .limit(cap + 1),
  ]);
  if (receipts.length > cap) {
    // Oldest first, capped: the NEWEST receipts are the ones missing.
    truncated = true;
    receipts.length = cap;
  }
  if (sessions.length > cap) {
    truncated = true;
    sessions.length = cap;
  }

  // ── status moves, from the write receipts ─────────────────────────────────
  let prev: string | null = null;
  for (const r of receipts) {
    const status = r.status;
    if (!status) continue;
    const at = iso(r.at)!;
    if (prev !== null && status !== prev) {
      const base = {
        id: `event:${r.id}`,
        at,
        stageKey: r.currentStage ?? null,
        refs: {},
      };
      const gate =
        r.checkGate && typeof r.checkGate === "object"
          ? (r.checkGate as Record<string, unknown>)
          : null;
      if (status === "paused" && gate) {
        // The check's hold. Represented by the stamp on the move it measured,
        // when there is one; recovered from the receipt for older moves.
        const moved = [...history]
          .reverse()
          .find((e) => Date.parse(e.enteredAt) <= Date.parse(at));
        if (!moved?.check && typeof gate.fromStage === "string") {
          out.push({
            event: {
              ...base,
              stageKey:
                typeof gate.stageKey === "string"
                  ? gate.stageKey
                  : base.stageKey,
              kind: "check_held",
              fromStage: gate.fromStage,
              failing: Array.isArray(gate.failing)
                ? gate.failing.filter((f): f is string => typeof f === "string")
                : [],
              reason:
                typeof gate.reason === "string" && gate.reason
                  ? gate.reason
                  : null,
              actor: SYSTEM,
            },
            actorId: null,
            isAgent: false,
          });
        }
      } else if (status === "paused") {
        out.push({
          event: { ...base, kind: "paused" },
          actorId: r.userId,
          isAgent: false,
        });
      } else if (prev === "paused" && status === "active") {
        out.push({
          event: { ...base, kind: "resumed" },
          actorId: r.userId,
          isAgent: false,
        });
      } else {
        out.push({
          event: {
            ...base,
            kind: "status_changed",
            fromStatus: prev,
            toStatus: status,
          },
          actorId: r.userId,
          isAgent: false,
        });
      }
    }
    prev = status;
  }

  // ── sessions (+ the graded contract on close) ─────────────────────────────
  const open = new Set<string>(OPEN_SESSION_STATUSES);
  const settledIds = sessions
    .filter((s) => !open.has(s.status))
    .map((s) => s.id);
  const evaluations = settledIds.length
    ? await db
        .select({
          sessionId: sessionEvaluations.sessionId,
          criterionKey: sessionEvaluations.criterionKey,
          verdict: sessionEvaluations.verdict,
          evaluatorKind: sessionEvaluations.evaluatorKind,
          createdAt: sessionEvaluations.createdAt,
          attempt: sessionEvaluations.attempt,
        })
        .from(sessionEvaluations)
        .where(inArray(sessionEvaluations.sessionId, settledIds))
    : [];
  const evalsBySession = new Map<string, EvaluationRowLike[]>();
  for (const e of evaluations) {
    const list = evalsBySession.get(e.sessionId) ?? [];
    list.push(e as EvaluationRowLike);
    evalsBySession.set(e.sessionId, list);
  }
  for (const s of sessions) {
    const isAgent = Boolean(s.agentId) || s.origin === "agent";
    const actorId = s.agentId ?? (isAgent ? null : s.ownerId);
    const title = resolveSessionTitle(s) || "Session";
    const refs = { sessionId: s.id };
    const startedAt = iso(s.startedAt) ?? iso(s.createdAt);
    if (startedAt) {
      out.push({
        event: {
          id: `session:${s.id}:start`,
          kind: "session_started",
          at: startedAt,
          stageKey: s.trackStage ?? null,
          refs,
          title,
        },
        actorId,
        isAgent,
      });
    }
    if (!open.has(s.status)) {
      const criteria = Array.isArray(s.criteria)
        ? (s.criteria as Array<{ key: string; required?: boolean }>).filter(
            (c) => c && typeof c.key === "string"
          )
        : [];
      out.push({
        event: {
          id: `session:${s.id}:close`,
          kind: "session_closed",
          at: iso(s.closedAt) ?? iso(s.updatedAt)!,
          stageKey: s.trackStage ?? null,
          refs,
          title,
          sessionStatus: s.status,
          verdict: computeSessionVerdict(
            criteria,
            latestEvaluationPerCriterion(evalsBySession.get(s.id) ?? [])
          ).state,
        },
        actorId,
        isAgent,
      });
    }
  }

  // ── decisions: the track's stage gates + its readable sessions' proposals ─
  const sessionStage = new Map(sessions.map((s) => [s.id, s.trackStage]));
  const decisionRows = await db
    .select({
      id: proposals.id,
      status: proposals.status,
      createdAt: proposals.createdAt,
      reviewedAt: proposals.reviewedAt,
      reviewedBy: proposals.reviewedBy,
      agentUserId: proposals.agentUserId,
      authorId: drizzleSql<
        string | null
      >`coalesce(${proposals.agentUserId}, ${proposals.proposedByUserId}, ${proposals.createdBy})`,
      sessionId: proposals.sessionId,
      targetType: proposals.targetType,
      summary: drizzleSql<
        string | null
      >`coalesce(nullif(${proposals.data}->>'_summary', ''), nullif(${proposals.data}->>'summary', ''), nullif(${proposals.data}->>'stageName', ''))`,
      gateStage: drizzleSql<string | null>`${proposals.data}->>'stageKey'`,
      rejectionReason: proposals.rejectionReason,
      comments: proposals.comments,
    })
    .from(proposals)
    .where(
      and(
        or(
          and(
            eq(proposals.targetType, TRACK_STAGE_GATE_TARGET_TYPE),
            eq(proposals.targetId, track.id)
          ),
          sessionStage.size
            ? inArray(proposals.sessionId, [...sessionStage.keys()])
            : undefined
        ),
        or(
          eq(proposals.status, "pending"),
          and(
            inArray(proposals.status, [...DECISION_STATUSES]),
            isNotNull(proposals.reviewedBy),
            isNotNull(proposals.reviewedAt)
          )
        )
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(cap + 1);
  if (decisionRows.length > cap) {
    truncated = true;
    decisionRows.length = cap;
  }
  for (const p of decisionRows) {
    const stageKey =
      p.targetType === TRACK_STAGE_GATE_TARGET_TYPE && p.gateStage
        ? p.gateStage
        : ((p.sessionId ? sessionStage.get(p.sessionId) : null) ?? null);
    const refs = {
      proposalId: p.id,
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
    };
    if (p.status === "pending") {
      out.push({
        event: {
          id: `proposal:${p.id}:ask`,
          kind: "decision_asked",
          at: iso(p.createdAt)!,
          stageKey,
          refs,
          title: p.summary ?? null,
        },
        actorId: p.authorId,
        isAgent: Boolean(p.agentUserId),
      });
      continue;
    }
    const approvalNote = readProposalReviewComments(p.comments)
      .filter((c) => c.kind === "approval")
      .at(-1)?.text;
    out.push({
      event: {
        id: `proposal:${p.id}:answer`,
        kind: "decision_answered",
        at: iso(p.reviewedAt)!,
        stageKey,
        refs,
        title: p.summary ?? null,
        decision: p.status,
        note:
          (p.status === "rejected" ? p.rejectionReason : approvalNote) ?? null,
      },
      actorId: p.reviewedBy,
      isAgent: false,
    });
  }

  // ── name every actor, in one read ─────────────────────────────────────────
  const rows = await loadActorRows(out.map((p) => p.actorId));
  const named = out.map(
    (p) =>
      ({
        ...p.event,
        actor:
          p.event.actor ??
          activityActorOf(
            p.actorId,
            p.actorId ? rows.get(p.actorId) : undefined,
            actor.userId,
            p.isAgent
          ),
      }) as TrackHistoryEvent
  );
  named.sort((a, b) => {
    const d = Date.parse(b.at) - Date.parse(a.at);
    if (d !== 0) return d;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return { trackId: track.id, events: named, truncated };
}
