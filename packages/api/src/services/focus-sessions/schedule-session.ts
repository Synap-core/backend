/**
 * materializeScheduledSession — the producer for `FocusSessionStatus.SCHEDULED`.
 *
 * `SCHEDULED = "scheduled"` has been in the status enum, in the column enum, in
 * `OPEN_SESSION_STATUSES` and in `UPDATABLE_SESSION_STATUSES` since the model was
 * written, and NOTHING in the pod ever wrote it. The name was reserved and the
 * producer was never built. This is it.
 *
 * ── What a scheduled session IS ─────────────────────────────────────────────
 * An APPOINTMENT, not an unattended run. The founder's framing: *"a playbook that
 * creates, each week at a specified date, the work session — so instead of
 * launching it myself, I open the app and already know I should be doing this
 * session now."*
 *
 * So the difference from `runPlaybook` is not cosmetic — it is WHO the row is
 * waiting for:
 *
 *   runPlaybook  → session(active) + channel + playbook_runs row + AGENT KICKOFF
 *   this         → session(scheduled). Full stop.
 *
 * Concretely, and each one deliberately:
 *   - NO agent kickoff. The kickoff lives in `runPlaybook`'s step 5 (the executor
 *     spine → `triggerAutoRespond`); this function never reaches it, so there is
 *     nothing to suppress and no flag that could be forgotten. An appointment
 *     that dispatched an agent would do the work the human was supposed to show
 *     up for.
 *   - NO `playbook_runs` ledger row. A run row means "this ran"; nothing ran. A
 *     row here would put an appointment nobody has opened into the runs feed as a
 *     `running` run that never completes, and the playbook-run reaper would
 *     eventually force-fail it.
 *   - NO channel. The channel is the run's ROOM; it is created when work starts.
 *     `focus_sessions.channelId` is nullable and `ensureSessionChannel` already
 *     creates one on demand when the human opens the session.
 *
 * Everything the session itself needs — goal/title, `metadata.prompt`,
 * expectedOutputs, `currentStage` from `stages[0]`, the
 * `session --instantiated_from--> playbook` edge and the optional
 * `session --targets--> project` edge — is produced by REUSING
 * `instantiateSession` with `status: "scheduled"`. There is no second session
 * constructor here; adding the status parameter to the existing one was the whole
 * change on that side.
 *
 * ── Where the schedule lives ────────────────────────────────────────────────
 * Nowhere new. A playbook's `schedule { cron, enabled, mode }` already maintains
 * exactly ONE backing cron `automations` row
 * (`services/playbooks/cron-automation.ts`), which the EXISTING
 * `automation-cron-scheduler` worker fires every minute off
 * `triggerConfig.expression`. `mode: "appointment"` only changes what the flow's
 * `playbook_run` node does when it fires. No second scheduler, no appointments
 * table, no new cron parser.
 *
 * ── VISIBILITY: the appointment is `kind: 'work'`, and WHY. ─────────────────
 * `session-kind.ts`'s run predicate is a THREE-arm OR, and the arms are
 * independent:
 *
 *     origin ∈ ("playbook","automation")  OR  playbookId IS NOT NULL
 *                                         OR  metadata.automationId/RunId present
 *
 * `instantiateSession` sets `playbookId` (it is how the run spine's
 * idempotency-by-subject query finds a session, and how THIS file's roll-forward
 * query finds its predecessor), so the SECOND arm fires on every appointment
 * regardless of origin. `origin: "human"` below is therefore NECESSARY BUT NOT
 * SUFFICIENT: it makes the field truthful and keeps the row out of triage, but
 * on its own it would not reach the Work lens.
 *
 * What carries it there is a clause in `session-kind.ts` itself: `status ===
 * 'scheduled'` is a work signal that OVERRIDES the run arms, in both the SQL
 * halves and `projectSessionKind`. An appointment is a standing invitation to
 * the human, whatever machinery materialised it — so the status the scheduler
 * writes, not the provenance, decides the lens. Keep the two in step: the
 * TypeScript projector and the SQL predicate are pinned together by
 * `__tests__/session-kind.test.ts`, whose polarity guard fails if either half
 * flips.
 *
 * The two workarounds that were considered here remain REFUSED, and must stay
 * refused: dropping `playbookId` would break the run spine's idempotency query
 * AND this file's own, and stamping `metadata.triage.acceptedAt` would forge a
 * human acceptance that never happened.
 *
 * GOVERNANCE: a pure domain operation, like `runPlaybook`. The caller gates.
 */

import { getDb, eq, and, desc, isNull, focusSessions } from "@synap/database";
import type { FocusSession } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import {
  instantiateSession,
  resolveRunnablePlaybook,
} from "../playbooks/playbook-lifecycle.js";

const logger = createLogger({ module: "schedule-session" });

/**
 * `metadata` key: the ISO slot this appointment is FOR. Written on every
 * materialization and rewritten on every roll-forward, so the surface can always
 * say "this is your Monday 9am session" rather than showing a creation timestamp
 * from three weeks ago.
 */
export const SCHEDULED_FOR_METADATA_KEY = "scheduledFor";

/**
 * `metadata` key: how many slots have come and gone with this appointment still
 * unopened. 0 on a fresh one; incremented by each roll-forward.
 *
 * This is the ONLY durable record that you have skipped this session N times —
 * see the accumulation policy below, which is why the count has to exist.
 */
export const SCHEDULED_MISSED_COUNT_METADATA_KEY = "missedCount";

/**
 * `metadata` key: WHAT MATERIALIZED this row — `{ playbookId, automationId?,
 * automationRunId? }`.
 *
 * `origin` answers "who AUTHORED this" (see the `origin: "human"` argument at
 * the insert below). This answers "what MATERIALIZED it". They are different
 * questions and the row needs both: without this, `origin: 'human'` on a row a
 * cron created would erase the provenance entirely.
 *
 * ⚠️ NESTED, and the nesting is load-bearing. `session-kind.ts` reads
 * `AUTOMATION_KEYS = ["automationRunId", "automationId"]` at the metadata bag's
 * TOP LEVEL (`metadata #>> '{automationId}'`), and a non-null value at either
 * key classifies the row as `kind: 'run'` — which the Work lens excludes. Under
 * `scheduledBy` the same ids are recorded losslessly and read by nobody's
 * predicate. Do NOT flatten this object, and do NOT reuse
 * `buildRunSessionMetadata` here: it stamps those keys top-level on purpose,
 * because a playbook RUN really is a run.
 */
export const SCHEDULED_BY_METADATA_KEY = "scheduledBy";

export interface ScheduleSessionInput {
  /** Resolve the playbook by id; when absent, `playbookName` is used. */
  playbookId?: string;
  playbookName?: string;
  workspaceId: string;
  /** The principal the appointment belongs to — whose app it shows up in. */
  userId: string;
  params?: Record<string, unknown>;
  /** The entity this appointment is about (weekly review OF this client). */
  subjectId?: string | null;
  /**
   * The moment this appointment is FOR. The cron scheduler's tick time, passed
   * in rather than read from the clock here so the stored slot is the SCHEDULED
   * moment, not "whenever the worker got round to it".
   */
  scheduledFor: Date;
  /** Resolves the playbook's goalTemplate against the caller's own context. */
  goalResolver?: (goalTemplate: string) => string | undefined;
  /**
   * WHAT materialized this appointment — recorded under
   * `metadata.scheduledBy`. The automation ids are optional because a caller
   * outside the cron path (a manual "put this on my calendar") has none.
   */
  scheduledBy?: { automationId?: string; automationRunId?: string };
  /** Extra session metadata (automation chain context, governance stamps). */
  metadata?: Record<string, unknown>;
}

export type ScheduleSessionResult = {
  session: FocusSession;
  /**
   * What actually happened at this slot:
   *  - `created`      — a new appointment now exists.
   *  - `rolled`       — the previous, UNOPENED appointment was moved to this slot
   *                     and its miss counter incremented (no second row).
   */
  outcome: "created" | "rolled";
  /** Slots missed so far, AFTER this materialization. 0 on a fresh appointment. */
  missedCount: number;
};

function readMissedCount(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object") return 0;
  const raw = (metadata as Record<string, unknown>)[
    SCHEDULED_MISSED_COUNT_METADATA_KEY
  ];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : 0;
}

/**
 * Materialize the appointment for one slot.
 *
 * ── IDEMPOTENCY, and what happens to an appointment nobody opened ───────────
 * These are ONE question, and answering them separately is how you get two
 * competing rules. The cron scheduler fires every minute; an automation run can
 * be retried; a weekly appointment comes round again whether or not you did last
 * week's. All three are the same danger: a second `scheduled` row for the same
 * thing.
 *
 * THE INVARIANT: at most ONE open appointment per
 * (workspace, user, playbook, subject) at a time.
 *
 * It is enforced by looking for an existing `status: 'scheduled'` session on the
 * same four keys before creating anything — the idempotency-by-subject shape
 * `runPlaybook` uses (`executeSingleRun` step 0), narrowed to the one status an
 * appointment can be in and scoped to ONE person's calendar in ONE workspace
 * (see the comment at the query itself for why the lens keys are load-bearing).
 *
 * When one is found we ROLL IT FORWARD: same row, new `scheduledFor`,
 * `missedCount + 1`. We deliberately do NOT:
 *   - create a second row (the prior-art failure: unconditional scheduled runs
 *     pile up unread and kill the surface — a list of eleven identical "Weekly
 *     review" appointments is a list nobody opens again);
 *   - silently skip (the appointment would keep showing LAST month's date while
 *     claiming to be what you should do now — the surface would be lying);
 *   - close/cancel the old one (a terminal status must go through
 *     `completeFocusSession`, and "you didn't do it" is not a completion).
 *
 * Roll-forward keeps the promise the product makes — the session on screen is
 * dated NOW and is the thing to do now — while `missedCount` makes the skipping
 * VISIBLE instead of erasing it. An appointment you have blown off four times
 * should say so.
 *
 * ── What deliberately does NOT block a new appointment ──────────────────────
 * Only a `scheduled` session participates. An `active`/`paused` session from a
 * previous occurrence — you opened last week's review and never closed it — does
 * NOT suppress this week's appointment: that row is your IN-PROGRESS WORK, not
 * your calendar, and letting it gate the calendar means one un-closed session
 * silently stops the schedule forever (an invisible stop, the worst outcome
 * here). Aging those out is the focus-session reaper's job
 * (`REAPER_STALE_HOURS`), which is scoped to exactly `active`/`paused` and never
 * touches a `scheduled` row.
 */
export async function materializeScheduledSession(
  input: ScheduleSessionInput
): Promise<ScheduleSessionResult> {
  const db = await getDb();

  // ONE resolution door, shared with runPlaybook — including the cross-workspace
  // visibility guard (the flow node's playbookId is editor-authored, no FK).
  const playbook = await resolveRunnablePlaybook({
    playbookId: input.playbookId,
    playbookName: input.playbookName,
    workspaceId: input.workspaceId,
  });

  const subjectId = input.subjectId ?? null;
  const slot = input.scheduledFor.toISOString();

  // ── The invariant: at most ONE open appointment per
  // (workspace, user, playbook, subject). ────────────────────────────────────
  // The lens keys are NOT optional here. A playbook can be pod-scoped and
  // therefore runnable from several workspaces (`resolveRunnablePlaybook`
  // permits exactly that), and `focus_sessions` is per-user. Without both keys
  // workspace B's tick would find workspace A's appointment, roll A's calendar
  // forward to B's slot and bump A's `missedCount` for a slot A never missed —
  // and B would then never get a row of its own. Every appointment belongs to
  // ONE person's calendar in ONE workspace; the uniqueness is per calendar.
  const existing = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.workspaceId, input.workspaceId),
      eq(focusSessions.userId, input.userId),
      eq(focusSessions.playbookId, playbook.id),
      eq(focusSessions.status, "scheduled"),
      // `subjectEntityId` is nullable, and `eq(col, null)` compiles to
      // `= NULL` — always false — which would make every unbound appointment
      // miss its own predecessor and create a new row every single slot. That is
      // the exact accumulation this function exists to prevent, so the null case
      // gets `isNull`, not `eq`.
      subjectId
        ? eq(focusSessions.subjectEntityId, subjectId)
        : isNull(focusSessions.subjectEntityId)
    ),
    orderBy: [desc(focusSessions.startedAt)],
  });

  if (existing) {
    const missedCount = readMissedCount(existing.metadata) + 1;
    const [rolled] = await db
      .update(focusSessions)
      .set({
        metadata: {
          ...((existing.metadata ?? {}) as Record<string, unknown>),
          [SCHEDULED_FOR_METADATA_KEY]: slot,
          [SCHEDULED_MISSED_COUNT_METADATA_KEY]: missedCount,
          // Provenance follows the SLOT, not the row. Left alone, this keeps
          // naming the automation run that minted the appointment months ago,
          // while the date beside it is the one THIS tick just wrote — so the
          // one field that exists to answer "what put this here" would answer
          // for a different occurrence than the row displays. The playbook is
          // the same by construction (it is the query's own key); the run ids
          // are this tick's.
          [SCHEDULED_BY_METADATA_KEY]: {
            playbookId: playbook.id,
            ...(input.scheduledBy ?? {}),
          },
        },
        updatedAt: new Date(),
      })
      // Re-assert `status = 'scheduled'` in the WHERE: between the read above and
      // this write the human may have OPENED the appointment (scheduled → active
      // through the ordinary update door). Rolling a session someone just started
      // back onto a future slot would rewrite live work as a calendar entry.
      // Unmatched ⇒ 0 rows ⇒ we fall through and create the next appointment,
      // which is correct: the old one is now in-progress work, not the calendar.
      .where(
        and(
          eq(focusSessions.id, existing.id),
          eq(focusSessions.status, "scheduled"),
          // Re-assert the lens keys too, so the compare-and-set can never write
          // outside the calendar the read was scoped to.
          eq(focusSessions.workspaceId, input.workspaceId),
          eq(focusSessions.userId, input.userId)
        )
      )
      .returning();

    if (rolled) {
      logger.info(
        {
          playbookId: playbook.id,
          sessionId: rolled.id,
          subjectId,
          scheduledFor: slot,
          missedCount,
        },
        "Rolled an unopened scheduled session forward to its next slot (no duplicate appointment)"
      );
      return {
        session: rolled as FocusSession,
        outcome: "rolled",
        missedCount,
      };
    }
  }

  // ── No open appointment → materialize one. ─────────────────────────────────
  // REUSES instantiateSession: goal/title, metadata.prompt, expectedOutputs,
  // currentStage from stages[0], the instantiated_from edge and the optional
  // targets→project edge all come from there. The ONLY difference is the status
  // it is born in — and the fact that, unlike runPlaybook, nothing downstream
  // dispatches an agent.
  const session = await instantiateSession({
    playbookId: playbook.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    params: input.params,
    // UNATTENDED, like every cron path: an unanswered required param becomes an
    // owed slot on the appointment rather than killing the recurrence. The
    // person opening the appointment then sees the question waiting for them —
    // which is exactly where an appointment puts them anyway.
    onMissingRequired: "owe",
    subjectId,
    goalOverride: input.goalResolver
      ? input.goalResolver(playbook.goalTemplate)
      : undefined,
    status: "scheduled",
    // ── `origin: "human"` on a row a cron created. This is deliberate. ───────
    // `origin` is defined (schema/focus-sessions.ts) as WHO AUTHORED the
    // session: *"`human` is a session a PERSON started at a door with no agent
    // identity. It is the value the triage lens keys on by absence:
    // agent/automation/inbound sessions need a look, a session the operator
    // opened themselves does not."*
    //
    // An appointment is materialized from a recurrence THE OPERATOR AUTHORED.
    // They already said yes — at authoring time. The cron is the executor, not
    // the author. So `human` is the truthful value here, and `automation` would
    // be the misleading one: it would put the row in the triage lens and ask the
    // person to re-accept something they explicitly asked for every week.
    //
    // Provenance is NOT lost — `metadata.scheduledBy` records what materialized
    // it (see SCHEDULED_BY_METADATA_KEY). Two different questions, two fields.
    //
    // ⚠️ This does NOT by itself make the row visible in the Work lens — see the
    // `playbookId` note in this file's header. It is necessary, not sufficient.
    origin: "human",
    metadata: {
      ...(input.metadata ?? {}),
      [SCHEDULED_FOR_METADATA_KEY]: slot,
      [SCHEDULED_MISSED_COUNT_METADATA_KEY]: 0,
      [SCHEDULED_BY_METADATA_KEY]: {
        playbookId: playbook.id,
        ...(input.scheduledBy ?? {}),
      },
    },
  });

  logger.info(
    {
      playbookId: playbook.id,
      sessionId: session.id,
      subjectId,
      scheduledFor: slot,
    },
    "Materialized a scheduled session (appointment) — waiting for the human, no agent dispatched"
  );

  return { session, outcome: "created", missedCount: 0 };
}
