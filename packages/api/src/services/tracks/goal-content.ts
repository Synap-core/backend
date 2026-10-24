/**
 * WHAT A GOAL HOLDS — the pod half (work model W2, 2026-10-23).
 *
 * A goal (a track) holds an end state, 0 or 2–5 criteria, drop conditions, a
 * kind of work and an uncertainty level (0345); per criterion, the judge's
 * acceptance. This file owns:
 *
 *   · the INPUT of those fields, shared by every door (`trackGoalInputSchema`,
 *     `parseTrackGoalInput`) and the patch they resolve to
 *     (`resolveTrackGoalPatch`) — the write itself is the tracks service's
 *     (`startTrack`, `setTrackDirection` / `applyTrackDirection`);
 *   · the READ of a goal's criteria (`readGoalCriteria` — the session reader
 *     `readCriteria`, plus each entry's stored `acceptance`);
 *   · the DERIVED facts every track read returns (`loadTrackGoalFacts`):
 *     each criterion's mark, `inReview` and `waitingOn` — computed by the
 *     pure rules in `@synap-core/types/units` (`deriveGoalCriteria`,
 *     `goalInReview`, `deriveWaitingOn`), never stored;
 *   · WHO JUDGES a goal (`isGoalJudge`) — the participants' answer
 *     (`loadGoalJudge`: the judge seat, else the owner), never re-derived.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  and,
  drizzleSql,
  eq,
  inArray,
  notInArray,
  or,
  focusSessions,
  getDb,
  proposals,
  sessionEvaluations,
  type TrackGoalPatch,
} from "@synap/database";
import {
  PROJECT_TRACK_UNCERTAINTY_LEVELS,
  PROJECT_TRACK_WORK_KINDS,
  ProposalStatus,
  type ProjectTrack,
  type ProjectTrackUncertainty,
  type ProjectTrackWorkKind,
} from "@synap/database/schema";
import { readCriteria, type SessionCriterion } from "@synap/playbooks";
import {
  checkGoalCriteriaCount,
  deriveGoalCriteria,
  deriveWaitingOn,
  goalInReview,
  isTrackUncertainty,
  isTrackWorkKind,
  owedSlotWaitingSources,
  readGoalCriterionAcceptance,
  type GoalCriterionAcceptance,
  type GoalCriterionClaim,
  type GoalCriterionView,
  type GoalRunFacts,
  type TrackUncertainty,
  type TrackWorkKind,
  type WaitingOnMark,
  type WaitingOnSource,
} from "@synap-core/types/units";
import {
  TERMINAL_SESSION_STATUSES,
  isTerminalSessionStatus,
} from "@synap-core/types/focus-sessions";
import {
  GOAL_LOOP_DEFAULT_ON,
  GOAL_LOOP_MAX_PER_WEEK,
  readGoalLoop,
} from "@synap-core/types/units";
import { sessionCriteriaSchema } from "../../schemas/session-criteria.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import {
  loadGoalJudge,
  loadGoalJudges,
  loadGoalOwner,
  participantDisplayNames,
} from "./track-participant-store.js";

// ── input ───────────────────────────────────────────────────────────────────

/** An end state is a short paragraph, not a document. */
export const TRACK_END_STATE_MAX = 2000;
/** A drop condition is one line; a goal names at most a handful. */
export const TRACK_DROP_CONDITION_MAX = 280;
export const TRACK_DROP_CONDITIONS_MAX = 5;

/**
 * What a goal holds, as a caller may write it. Each field WHOLE: absent
 * leaves it, `null` clears it. `confirmKind: true` is a PERSON confirming
 * the kind of work and uncertainty already stored (the AI proposed them). A
 * criterion's `acceptance` is never accepted here: the strict criterion
 * schema refuses it — the acceptance door is its only writer.
 */
export const trackGoalInputSchema = z
  .object({
    endState: z.string().trim().max(TRACK_END_STATE_MAX).nullable().optional(),
    criteria: sessionCriteriaSchema.nullable().optional(),
    dropConditions: z
      .array(z.string().trim().min(1).max(TRACK_DROP_CONDITION_MAX))
      .max(TRACK_DROP_CONDITIONS_MAX)
      .nullable()
      .optional(),
    workKind: z.enum(PROJECT_TRACK_WORK_KINDS).nullable().optional(),
    uncertainty: z.enum(PROJECT_TRACK_UNCERTAINTY_LEVELS).nullable().optional(),
    confirmKind: z.boolean().optional(),
    /**
     * The goal's loop (W4): `on` — it proposes its next run while a required
     * criterion is unmet; `perWeek` — its budget (absent keeps the stored one,
     * else the default). Switching it on again is "try again" after a stop.
     * `null` clears it (off). An agent's switch-on is always a proposal.
     */
    loop: z
      .object({
        on: z.boolean(),
        perWeek: z.number().int().min(1).max(GOAL_LOOP_MAX_PER_WEEK).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type TrackGoalInput = z.infer<typeof trackGoalInputSchema>;

/** The goal fields, by name — what a door or a proposal payload may carry. */
export const TRACK_GOAL_INPUT_KEYS = [
  "endState",
  "criteria",
  "dropConditions",
  "workKind",
  "uncertainty",
  "confirmKind",
  "loop",
] as const satisfies ReadonlyArray<keyof TrackGoalInput>;
// Every input field is listed: a field added to the schema and not here
// would never ride a proposal — stop the build instead.
type _AllGoalKeys = [
  Exclude<keyof TrackGoalInput, (typeof TRACK_GOAL_INPUT_KEYS)[number]>,
] extends [never]
  ? true
  : never;
const _allGoalKeys: _AllGoalKeys = true;
void _allGoalKeys;

/** The goal fields present on `bag` (a door's args, a proposal's payload). */
export function pickTrackGoalInput(
  bag: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!bag) return out;
  for (const k of TRACK_GOAL_INPUT_KEYS) {
    if (k in bag && bag[k] !== undefined) out[k] = bag[k];
  }
  return out;
}

export function hasTrackGoalInput(bag: Record<string, unknown>): boolean {
  return Object.keys(pickTrackGoalInput(bag)).length > 0;
}

/**
 * Parse a goal patch, refusing it in words an agent can act on: the schema,
 * then the 2–5 rule (decision 1) — a goal has no criteria, or 2 to 5.
 */
export function parseTrackGoalInput(raw: unknown): TrackGoalInput {
  const parsed = trackGoalInputSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid goal: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "goal"} ${i.message}`)
        .join("; ")}.`,
    });
  }
  const criteria = parsed.data.criteria;
  if (criteria) {
    const refusal = checkGoalCriteriaCount(criteria.length);
    if (refusal) throw new TRPCError({ code: "BAD_REQUEST", message: refusal });
  }
  return parsed.data;
}

/**
 * A NEW goal's loop when its start names none: {@link GOAL_LOOP_DEFAULT_ON}
 * for a goal with criteria (OFF until the founder confirms), else untouched.
 * Applied at birth only — a stored goal with no loop always reads OFF.
 */
export function withBirthLoopDefault(input: TrackGoalInput): TrackGoalInput {
  if (input.loop !== undefined || !input.criteria?.length) return input;
  return GOAL_LOOP_DEFAULT_ON ? { ...input, loop: { on: true } } : input;
}

/**
 * An agent switching a goal's loop on is ALWAYS a proposal a person approves
 * (the loop then files work in the owner's name every week) — the gate's
 * `forcePropose`, whatever a governance rule would auto-approve.
 */
export function agentSwitchesLoopOn(
  input: TrackGoalInput,
  agentUserId: string | null | undefined
): boolean {
  return Boolean(agentUserId) && input.loop?.on === true;
}

// ── stored reads ────────────────────────────────────────────────────────────

/** A goal criterion as stored: the session criterion + the judge's decision. */
export type GoalCriterion = SessionCriterion & {
  acceptance: GoalCriterionAcceptance | null;
};

/**
 * A goal's criteria — the SAME tolerant reader as a session's
 * (`readCriteria`), plus each entry's stored `acceptance` (which
 * `readCriteria` does not know and would drop).
 */
export function readGoalCriteria(raw: unknown): GoalCriterion[] {
  const entries = Array.isArray(raw) ? raw : [];
  const acceptanceOf = new Map<string, unknown>();
  for (const e of entries) {
    if (
      e &&
      typeof e === "object" &&
      typeof (e as { key?: unknown }).key === "string"
    ) {
      const key = (e as { key: string }).key;
      if (!acceptanceOf.has(key)) {
        acceptanceOf.set(key, (e as { acceptance?: unknown }).acceptance);
      }
    }
  }
  return readCriteria(entries).map((c) => ({
    ...c,
    acceptance: readGoalCriterionAcceptance(acceptanceOf.get(c.key)),
  }));
}

/** A goal's drop conditions — a list of non-blank lines; anything else reads as none. */
export function readDropConditions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
}

/** The end state, trimmed; blank reads as unsaid. */
export function readEndState(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** Same statement and same check: a decision about it still describes it. */
function sameCriterionContract(a: SessionCriterion, b: SessionCriterion) {
  return (
    a.statement === b.statement &&
    a.check.kind === b.check.kind &&
    (a.check.capability ?? null) === (b.check.capability ?? null) &&
    (a.check.evidenceKey ?? null) === (b.check.evidenceKey ?? null) &&
    (a.required !== false) === (b.required !== false)
  );
}

// ── the patch a goal write resolves to ───────────────────────────────────────

type StoredGoal = Pick<
  ProjectTrack,
  | "loop"
  | "endState"
  | "criteria"
  | "dropConditions"
  | "workKind"
  | "uncertainty"
  | "kindConfirmedBy"
>;

/**
 * Resolve a parsed goal input against what is stored into the patch to write
 * — or `null` when nothing would change. `confirmedBy` is the PERSON whose
 * write this is (`null` for an agent's write applied without review):
 *   · a person writing the kind of work or uncertainty confirms them;
 *   · an agent changing either un-confirms them (it is a proposal of the
 *     AI's again until a person confirms);
 *   · `confirmKind` is a person's alone, and needs a kind or uncertainty.
 * Criteria are written whole; a criterion whose statement and check did not
 * change keeps the judge's decision on it, a changed one loses it (the
 * decision was about a different contract).
 */
export function resolveTrackGoalPatch(
  stored: StoredGoal | null,
  input: TrackGoalInput,
  confirmedBy: string | null,
  now: Date = new Date()
): TrackGoalPatch | null {
  const patch: TrackGoalPatch = {};
  let changed = false;

  if (input.endState !== undefined) {
    const next = readEndState(input.endState);
    if (next !== readEndState(stored?.endState)) {
      patch.endState = next;
      changed = true;
    }
  }

  if (input.dropConditions !== undefined) {
    const next = readDropConditions(input.dropConditions ?? []);
    const before = readDropConditions(stored?.dropConditions);
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      patch.dropConditions = next.length > 0 ? next : null;
      changed = true;
    }
  }

  if (input.criteria !== undefined) {
    const before = readGoalCriteria(stored?.criteria);
    const beforeByKey = new Map(before.map((c) => [c.key, c]));
    const next = readCriteria(input.criteria ?? []).map((c) => {
      const prior = beforeByKey.get(c.key);
      return prior?.acceptance && sameCriterionContract(prior, c)
        ? { ...c, acceptance: prior.acceptance }
        : c;
    });
    if (
      JSON.stringify(next) !== JSON.stringify(before.map(stripNullAcceptance))
    ) {
      patch.criteria = next.length > 0 ? next : null;
      changed = true;
    }
  }

  const kindIn =
    input.workKind !== undefined &&
    (input.workKind ?? null) !== (stored?.workKind ?? null);
  const uncertaintyIn =
    input.uncertainty !== undefined &&
    (input.uncertainty ?? null) !== (stored?.uncertainty ?? null);
  if (kindIn)
    patch.workKind = (input.workKind ?? null) as ProjectTrackWorkKind | null;
  if (uncertaintyIn) {
    patch.uncertainty = (input.uncertainty ??
      null) as ProjectTrackUncertainty | null;
  }
  const workKind = kindIn ? patch.workKind : (stored?.workKind ?? null);
  const uncertainty = uncertaintyIn
    ? patch.uncertainty
    : (stored?.uncertainty ?? null);

  if (input.confirmKind && !confirmedBy) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Only a person confirms a goal's kind of work and uncertainty — propose them, and the person confirms.",
    });
  }
  if (input.confirmKind && !workKind && !uncertainty) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Nothing to confirm — the goal has no kind of work or uncertainty yet.",
    });
  }
  if (kindIn || uncertaintyIn || input.confirmKind) {
    const confirm =
      confirmedBy && (workKind || uncertainty) ? confirmedBy : null;
    if (
      kindIn ||
      uncertaintyIn ||
      (confirm && confirm !== (stored?.kindConfirmedBy ?? null))
    ) {
      patch.kindConfirmedBy = confirm;
      patch.kindConfirmedAt = confirm ? now : null;
      changed = true;
    }
  }

  if (input.loop !== undefined) {
    const before = readGoalLoop(stored?.loop);
    if (input.loop === null) {
      if (stored?.loop != null) {
        patch.loop = null;
        changed = true;
      }
    } else {
      // Switching it on is always a write (it restamps `onAt`: "try again").
      // Who set it is the PERSON — the approver of an agent's proposal.
      const next = {
        on: input.loop.on,
        perWeek: input.loop.perWeek ?? before.perWeek,
        onAt: input.loop.on ? now.toISOString() : before.onAt,
        by: confirmedBy,
      };
      if (
        input.loop.on ||
        next.on !== before.on ||
        next.perWeek !== before.perWeek ||
        stored?.loop == null
      ) {
        patch.loop = next;
        changed = true;
      }
    }
  }

  return changed ? patch : null;
}

function stripNullAcceptance(
  c: GoalCriterion
): SessionCriterion | GoalCriterion {
  if (c.acceptance) return c;
  const { acceptance: _a, ...rest } = c;
  return rest;
}

// ── who judges ──────────────────────────────────────────────────────────────

/**
 * WHO JUDGES the goal — accepts its criteria (R2): the goal's judge seat,
 * else its owner (`loadGoalJudge`, the SAME answer the close reads — only the
 * judge closes, `assertGoalEnder`). A key acting as an agent is refused
 * before this is asked (`mayAcceptGoalCriterion`).
 */
export async function isGoalJudge(
  track: Pick<ProjectTrack, "id" | "userId">,
  userId: string
): Promise<boolean> {
  return (await loadGoalJudge(track)) === userId;
}

/**
 * THE PERSON TO ASK about a goal — its OWNER (never its judge): who the
 * goal's own news goes to (a blocker of it ended, its loop stopped and asks)
 * and whose name its next run is proposed under. The owner seat
 * (`loadGoalOwner` — the owner row, else the starter), the SAME answer W3's
 * R10 escalation reads (`goalOwner`).
 */
export async function goalOwnerToAsk(
  track: Pick<ProjectTrack, "id" | "userId">
): Promise<string> {
  return loadGoalOwner(track);
}

// ── derived facts every track read returns ──────────────────────────────────

/** What every track read adds about the goal's content — DERIVED, never stored. */
export interface TrackGoalFacts {
  criteria: GoalCriterionView[];
  inReview: boolean;
  waitingOn: WaitingOnMark[];
}

/**
 * THE read of a goal's RUNS — every session filed into each goal, with its
 * criterion keys, who worked it and (for a goal with criteria) its evaluation
 * rows: what `deriveGoalCriteria` and the loop (`goalCriteriaFailedTwice`)
 * read. Two queries for any number of goals. Every member's runs: the goal is
 * the project's; marks and counts only, never a session's content. A failed
 * read THROWS.
 */
export async function loadGoalRuns(
  tracks: ReadonlyArray<Pick<ProjectTrack, "id" | "criteria">>
): Promise<{
  sessions: Awaited<ReturnType<typeof selectGoalSessions>>;
  runsOf: Map<string, GoalRunFacts[]>;
}> {
  const runsOf = new Map<string, GoalRunFacts[]>();
  if (tracks.length === 0) return { sessions: [], runsOf };
  const db = await getDb();
  const sessions = await selectGoalSessions(tracks.map((t) => t.id));
  const withCriteria = new Set(
    tracks.filter((t) => readCriteria(t.criteria).length > 0).map((t) => t.id)
  );
  const gradedSessionIds = sessions
    .filter((s) => s.trackId && withCriteria.has(s.trackId))
    .map((s) => s.id);
  const evaluations =
    gradedSessionIds.length > 0
      ? await db
          .select({
            id: sessionEvaluations.id,
            sessionId: sessionEvaluations.sessionId,
            criterionKey: sessionEvaluations.criterionKey,
            verdict: sessionEvaluations.verdict,
            evaluatorKind: sessionEvaluations.evaluatorKind,
            evaluatorId: sessionEvaluations.evaluatorId,
            rationale: sessionEvaluations.rationale,
            attempt: sessionEvaluations.attempt,
            createdAt: sessionEvaluations.createdAt,
          })
          .from(sessionEvaluations)
          .where(inArray(sessionEvaluations.sessionId, gradedSessionIds))
      : [];
  const rowsBySession = new Map<string, typeof evaluations>();
  for (const e of evaluations) {
    const list = rowsBySession.get(e.sessionId) ?? [];
    list.push(e);
    rowsBySession.set(e.sessionId, list);
  }
  for (const track of tracks) {
    runsOf.set(
      track.id,
      sessions
        .filter((s) => s.trackId === track.id)
        .map((s) => ({
          sessionId: s.id,
          ownerId: s.userId,
          open: !isTerminalSessionStatus(s.status),
          criterionKeys: readCriteria(s.criteria).map((c) => c.key),
          authors: runAuthors(s),
          evaluations: rowsBySession.get(s.id) ?? [],
        }))
    );
  }
  return { sessions, runsOf };
}

/** Who did a run's work: its owner, its agents, the model that ran it. */
function runAuthors(s: {
  userId: string;
  agentIds: string[] | null;
  modelId: string | null;
}): string[] {
  return [s.userId, ...(s.agentIds ?? []), ...(s.modelId ? [s.modelId] : [])];
}

/** The runs filed into `trackIds` — every one, or only the open ones. */
async function selectGoalSessions(
  trackIds: string[],
  opts: { openOnly?: boolean } = {}
) {
  const db = await getDb();
  return db
    .select({
      id: focusSessions.id,
      trackId: focusSessions.trackId,
      title: focusSessions.title,
      status: focusSessions.status,
      userId: focusSessions.userId,
      criteria: focusSessions.criteria,
      agentIds: focusSessions.agentIds,
      // Only the model id is read off `metadata` (F4), never the whole bag.
      modelId: drizzleSql<
        string | null
      >`nullif(${focusSessions.metadata}->>'modelId', '')`,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.trackId, trackIds),
        opts.openOnly
          ? notInArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES])
          : undefined
      )
    );
}

/** `execute` resolves to the rows (postgres-js) or to `{ rows }` (pglite). */
function executedRows<T>(result: unknown): T[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] } | null)?.rows ?? [])
  ) as T[];
}

const sqlList = (values: readonly string[]) =>
  drizzleSql.join(
    values.map((v) => drizzleSql`${v}`),
    drizzleSql`, `
  );

/**
 * THE LIST READ of goal runs (code-core F4) — what `deriveGoalCriteria` can
 * pick, never every run a goal ever had. Three queries for any number of
 * goals:
 *   · the OPEN runs, whole (under way, what they owe, their proposals);
 *   · per goal, criterion and kind of row, the LATEST evaluation on a run
 *     that carries that criterion — human, measured (evidence, capability),
 *     other — with its run's owner, agents and title: the derivation's
 *     current row is the latest human row else the latest row
 *     (`latestEvaluationPerCriterion`), its value the latest measured row,
 *     so no older row can change a mark;
 *   · the criterion keys CLOSED runs carried — "not met" (tried, none open)
 *     versus "not started" — aggregated in SQL, standing in as one run with
 *     no rows of its own.
 * The loop and anything that needs a goal's whole history read
 * {@link loadGoalRuns}; `goal-reads-w5.pglite.test.ts` (F4) holds the two
 * derivations equal. A failed read THROWS.
 */
export async function loadGoalRunsForRead(
  tracks: ReadonlyArray<Pick<ProjectTrack, "id" | "criteria">>
): Promise<{
  openSessions: Awaited<ReturnType<typeof selectGoalSessions>>;
  titleOf: Map<string, string | null>;
  runsOf: Map<string, GoalRunFacts[]>;
}> {
  const runsOf = new Map<string, GoalRunFacts[]>();
  const titleOf = new Map<string, string | null>();
  if (tracks.length === 0) return { openSessions: [], titleOf, runsOf };
  const db = await getDb();
  const graded = tracks
    .filter((t) => readCriteria(t.criteria).length > 0)
    .map((t) => t.id);
  const terminal = sqlList(TERMINAL_SESSION_STATUSES);
  // The kind of row the derivation tells apart: a person's grade (it wins
  // over any other), a measured one (it gives the value), any other.
  const rank = drizzleSql`(CASE WHEN e.evaluator_kind = 'human' THEN 0
      WHEN e.evaluator_kind IN ('evidence', 'capability') THEN 1
      ELSE 2 END)`;
  const [openSessions, carriedRaw, latestRaw] = await Promise.all([
    selectGoalSessions(
      tracks.map((t) => t.id),
      { openOnly: true }
    ),
    graded.length > 0
      ? db.execute(drizzleSql`
          SELECT DISTINCT s.track_id AS "trackId", c->>'key' AS "key"
          FROM ${focusSessions} s,
               LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(s.criteria) = 'array'
                      THEN s.criteria ELSE '[]'::jsonb END
               ) c
          WHERE s.track_id IN (${sqlList(graded)})
            AND s.status IN (${terminal})
            AND c->>'key' IS NOT NULL
        `)
      : Promise.resolve([]),
    graded.length > 0
      ? db.execute(drizzleSql`
          SELECT DISTINCT ON (s.track_id, e.criterion_key, ${rank})
                 s.track_id AS "trackId",
                 e.id AS "id",
                 e.session_id AS "sessionId",
                 e.criterion_key AS "criterionKey",
                 e.verdict AS "verdict",
                 e.evaluator_kind AS "evaluatorKind",
                 e.evaluator_id AS "evaluatorId",
                 e.rationale AS "rationale",
                 e.attempt AS "attempt",
                 e.created_at AS "createdAt",
                 s.status AS "status",
                 s.title AS "title",
                 s.user_id AS "userId",
                 s.agent_ids AS "agentIds",
                 nullif(s.metadata->>'modelId', '') AS "modelId"
          FROM ${sessionEvaluations} e
          JOIN ${focusSessions} s ON s.id = e.session_id
          WHERE s.track_id IN (${sqlList(graded)})
            AND jsonb_typeof(s.criteria) = 'array'
            AND s.criteria @> jsonb_build_array(
                  jsonb_build_object('key', e.criterion_key))
          ORDER BY s.track_id, e.criterion_key, ${rank},
                   e.created_at DESC, e.attempt DESC NULLS LAST
        `)
      : Promise.resolve([]),
  ]);
  const carried = executedRows<{ trackId: string; key: string }>(carriedRaw);
  const latest = executedRows<{
    trackId: string;
    id: string;
    sessionId: string;
    criterionKey: string;
    verdict: GoalRunFacts["evaluations"][number]["verdict"];
    evaluatorKind: GoalRunFacts["evaluations"][number]["evaluatorKind"];
    evaluatorId: string | null;
    rationale: string | null;
    attempt: number | null;
    createdAt: Date | string;
    status: string;
    title: string | null;
    userId: string;
    agentIds: string[] | null;
    modelId: string | null;
  }>(latestRaw);

  // Every run the read touched, by id: the open ones whole, the closed ones
  // the latest rows came from (carrying at least those rows' keys).
  const runs = new Map<string, GoalRunFacts & { trackId: string }>();
  for (const s of openSessions) {
    if (!s.trackId) continue;
    titleOf.set(s.id, s.title);
    runs.set(s.id, {
      trackId: s.trackId,
      sessionId: s.id,
      ownerId: s.userId,
      open: true,
      criterionKeys: readCriteria(s.criteria).map((c) => c.key),
      authors: runAuthors(s),
      evaluations: [],
    });
  }
  for (const r of latest) {
    titleOf.set(r.sessionId, r.title);
    let run = runs.get(r.sessionId);
    if (!run) {
      run = {
        trackId: r.trackId,
        sessionId: r.sessionId,
        ownerId: r.userId,
        open: !isTerminalSessionStatus(r.status),
        criterionKeys: [],
        authors: runAuthors(r),
        evaluations: [],
      };
      runs.set(r.sessionId, run);
    }
    if (!run.criterionKeys.includes(r.criterionKey)) {
      (run.criterionKeys as string[]).push(r.criterionKey);
    }
    (run.evaluations as GoalRunFacts["evaluations"][number][]).push({
      id: r.id,
      criterionKey: r.criterionKey,
      verdict: r.verdict,
      evaluatorKind: r.evaluatorKind,
      evaluatorId: r.evaluatorId,
      rationale: r.rationale,
      attempt: r.attempt ?? undefined,
      createdAt: r.createdAt,
    });
  }
  for (const track of tracks) runsOf.set(track.id, []);
  for (const { trackId, ...run } of runs.values()) {
    runsOf.get(trackId)?.push(run);
  }
  // What closed runs carried, as one run with no rows of its own.
  const carriedOf = new Map<string, string[]>();
  for (const c of carried) {
    carriedOf.set(c.trackId, [...(carriedOf.get(c.trackId) ?? []), c.key]);
  }
  for (const [trackId, keys] of carriedOf) {
    runsOf.get(trackId)?.push({
      sessionId: `carried:${trackId}`,
      ownerId: null,
      open: false,
      criterionKeys: keys,
      authors: [],
      evaluations: [],
    });
  }
  return { openSessions, titleOf, runsOf };
}

/**
 * The goal facts for MANY tracks in a bounded number of queries: the sessions
 * filed into them (every member's — the goal is the project's, like its check
 * gate; marks and counts only, never a session's content), their evaluation
 * rows, the pending proposals about the goal or its open runs the reader can
 * see, and `blocked_by` edges on the goal and its open runs. A failed read
 * THROWS — never folded into "nothing claimed, waiting on nothing".
 */
export async function loadTrackGoalFacts(
  tracks: ReadonlyArray<Pick<ProjectTrack, "id" | "userId" | "criteria">>,
  userId: string
): Promise<Map<string, TrackGoalFacts>> {
  const out = new Map<string, TrackGoalFacts>();
  if (tracks.length === 0) return out;
  const db = await getDb();
  const trackIds = tracks.map((t) => t.id);

  const [{ openSessions, titleOf, runsOf }, judges] = await Promise.all([
    loadGoalRunsForRead(tracks),
    loadGoalJudges(tracks),
  ]);
  const openSessionIds = openSessions.map((s) => s.id);

  // Loaded on first use, never at module init: `dependency-links` reaches the
  // router layer and, through it, `permission-check`, which sits on an import
  // cycle with the session services. Imported eagerly here, it changed the
  // order every importer of the tracks service initialises in, and suites that
  // stub `checkPermissionOrPropose` got the real ladder in the hand-off gate.
  const { readDependencyFacts } = await import("../links/dependency-links.js");
  const [pending, deps] = await Promise.all([
    db
      .select({
        targetType: proposals.targetType,
        targetId: proposals.targetId,
        sessionId: proposals.sessionId,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.status, ProposalStatus.PENDING),
          userVisibleWhere(proposals.workspaceId, userId),
          or(
            and(
              eq(proposals.targetType, "track"),
              inArray(proposals.targetId, trackIds)
            ),
            ...(openSessionIds.length > 0
              ? [inArray(proposals.sessionId, openSessionIds)]
              : [])
          )
        )
      ),
    readDependencyFacts(
      [
        ...trackIds.map((id) => ({ kind: "track", id })),
        ...openSessionIds.map((id) => ({ kind: "session", id })),
      ],
      userId
    ),
  ]);

  const trackOfSession = new Map(openSessions.map((s) => [s.id, s.trackId]));

  const statesOf = new Map(
    tracks.map((track) => [
      track.id,
      deriveGoalCriteria(
        readGoalCriteria(track.criteria),
        runsOf.get(track.id) ?? [],
        { judgeId: judges.get(track.id) ?? null }
      ),
    ])
  );
  // What backs each claim (its evidence) and who made it, by name — read
  // once for the whole list, only for the rows that claim something.
  const claims = [...statesOf.values()].flatMap((states) =>
    states.flatMap((st) => (st.claim ? [st.claim] : []))
  );
  const claimEvaluationIds = claims.flatMap((c) =>
    c.evaluationId ? [c.evaluationId] : []
  );
  const [evidenceRows, claimNames] = await Promise.all([
    claimEvaluationIds.length > 0
      ? db
          .select({
            id: sessionEvaluations.id,
            evidence: sessionEvaluations.evidence,
          })
          .from(sessionEvaluations)
          .where(inArray(sessionEvaluations.id, claimEvaluationIds))
      : Promise.resolve([]),
    participantDisplayNames(claims.flatMap((c) => (c.by ? [c.by] : []))),
  ]);
  const evidenceOf = new Map(
    evidenceRows.map((r) => [r.id, readClaimEvidence(r.evidence)])
  );
  const claimView = (
    c: NonNullable<ReturnType<typeof deriveGoalCriteria>[number]["claim"]>
  ): GoalCriterionClaim => ({
    by: c.by,
    byName: c.by ? (claimNames.get(c.by) ?? null) : null,
    sessionId: c.sessionId,
    sessionTitle: titleOf.get(c.sessionId)?.trim() || null,
    evidence: c.evaluationId ? (evidenceOf.get(c.evaluationId) ?? null) : null,
    note: c.note,
    at: c.at,
  });

  for (const track of tracks) {
    const criteria = readGoalCriteria(track.criteria);
    const filed = openSessions.filter((s) => s.trackId === track.id);
    const states = statesOf.get(track.id)!;
    const stateOf = new Map(states.map((s) => [s.key, s]));

    const sources: WaitingOnSource[] = [];
    for (const s of filed) {
      if (isTerminalSessionStatus(s.status)) continue;
      sources.push(
        ...owedSlotWaitingSources(
          Array.isArray(s.expectedOutputs)
            ? (s.expectedOutputs as Parameters<
                typeof owedSlotWaitingSources
              >[0][number][])
            : []
        )
      );
      const blockers = deps.get(`session:${s.id}`)?.openBlockers ?? 0;
      for (let i = 0; i < blockers; i++) sources.push({ kind: "blocked_by" });
    }
    const trackBlockers = deps.get(`track:${track.id}`)?.openBlockers ?? 0;
    for (let i = 0; i < trackBlockers; i++)
      sources.push({ kind: "blocked_by" });
    for (const p of pending) {
      const about =
        p.targetType === "track" && p.targetId === track.id
          ? true
          : p.sessionId != null && trackOfSession.get(p.sessionId) === track.id;
      if (about) sources.push({ kind: "pending_proposal" });
    }

    out.set(track.id, {
      criteria: criteria.map((c) => {
        const s = stateOf.get(c.key)!;
        return {
          ...c,
          mark: s.mark,
          acceptanceState: s.acceptanceState,
          meaning: s.meaning,
          currentValue: s.currentValue,
          claim: s.claim ? claimView(s.claim) : null,
        };
      }),
      inReview: goalInReview(criteria, states),
      waitingOn: deriveWaitingOn(sources),
    });
  }
  return out;
}

/** A claim's evidence — an object with something in it, else none. */
function readClaimEvidence(raw: unknown): Record<string, unknown> | null {
  return raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    Object.keys(raw).length > 0
    ? (raw as Record<string, unknown>)
    : null;
}

/** The kind of work, read tolerantly (a value no option declares reads as none). */
export function readTrackWorkKind(v: unknown): TrackWorkKind | null {
  return isTrackWorkKind(v) ? v : null;
}

/** The uncertainty, read tolerantly. */
export function readTrackUncertainty(v: unknown): TrackUncertainty | null {
  return isTrackUncertainty(v) ? v : null;
}
