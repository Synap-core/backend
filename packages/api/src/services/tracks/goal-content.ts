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
  eq,
  inArray,
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
  type GoalCriterionView,
  type GoalRunFacts,
  type TrackUncertainty,
  type TrackWorkKind,
  type WaitingOnMark,
  type WaitingOnSource,
} from "@synap-core/types/units";
import { isTerminalSessionStatus } from "@synap-core/types/focus-sessions";
import { sessionCriteriaSchema } from "../../schemas/session-criteria.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { loadGoalJudge } from "./track-participant-store.js";

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
 * judge closes, `assertGoalCloser`). A key acting as an agent is refused
 * before this is asked (`mayAcceptGoalCriterion`).
 */
export async function isGoalJudge(
  track: Pick<ProjectTrack, "id" | "userId">,
  userId: string
): Promise<boolean> {
  return (await loadGoalJudge(track)) === userId;
}

/**
 * WHO OWNS the goal — the person the goal's own news goes to (a blocker of it
 * ended, its loop stopped and asks) — today: the person who started it
 * (`project_tracks.user_id`). THE one place this is answered for W4: the
 * participants wave (W3) swaps it for the goal's owner seat (`goalOwner`).
 */
export function goalOwnerId(track: Pick<ProjectTrack, "userId">): string {
  return track.userId;
}

// ── derived facts every track read returns ──────────────────────────────────

/** What every track read adds about the goal's content — DERIVED, never stored. */
export interface TrackGoalFacts {
  criteria: GoalCriterionView[];
  inReview: boolean;
  waitingOn: WaitingOnMark[];
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
  tracks: ReadonlyArray<Pick<ProjectTrack, "id" | "criteria">>,
  userId: string
): Promise<Map<string, TrackGoalFacts>> {
  const out = new Map<string, TrackGoalFacts>();
  if (tracks.length === 0) return out;
  const db = await getDb();
  const trackIds = tracks.map((t) => t.id);

  const sessions = await db
    .select({
      id: focusSessions.id,
      trackId: focusSessions.trackId,
      status: focusSessions.status,
      userId: focusSessions.userId,
      criteria: focusSessions.criteria,
      agentIds: focusSessions.agentIds,
      metadata: focusSessions.metadata,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(inArray(focusSessions.trackId, trackIds));

  const withCriteria = new Set(
    tracks.filter((t) => readCriteria(t.criteria).length > 0).map((t) => t.id)
  );
  const gradedSessionIds = sessions
    .filter((s) => s.trackId && withCriteria.has(s.trackId))
    .map((s) => s.id);
  const openSessions = sessions.filter(
    (s) => !isTerminalSessionStatus(s.status)
  );
  const openSessionIds = openSessions.map((s) => s.id);

  // Loaded on first use, never at module init: `dependency-links` reaches the
  // router layer and, through it, `permission-check`, which sits on an import
  // cycle with the session services. Imported eagerly here, it changed the
  // order every importer of the tracks service initialises in, and suites that
  // stub `checkPermissionOrPropose` got the real ladder in the hand-off gate.
  const { readDependencyFacts } = await import("../links/dependency-links.js");
  const [evaluations, pending, deps] = await Promise.all([
    gradedSessionIds.length > 0
      ? db
          .select({
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
      : Promise.resolve([]),
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

  const trackOfSession = new Map(sessions.map((s) => [s.id, s.trackId]));
  const rowsBySession = new Map<string, typeof evaluations>();
  for (const e of evaluations) {
    const list = rowsBySession.get(e.sessionId) ?? [];
    list.push(e);
    rowsBySession.set(e.sessionId, list);
  }

  for (const track of tracks) {
    const criteria = readGoalCriteria(track.criteria);
    const filed = sessions.filter((s) => s.trackId === track.id);
    const runs: GoalRunFacts[] = filed.map((s) => {
      const modelId = (s.metadata as { modelId?: unknown } | null)?.modelId;
      return {
        sessionId: s.id,
        open: !isTerminalSessionStatus(s.status),
        criterionKeys: readCriteria(s.criteria).map((c) => c.key),
        authors: [
          s.userId,
          ...(s.agentIds ?? []),
          ...(typeof modelId === "string" && modelId ? [modelId] : []),
        ],
        evaluations: rowsBySession.get(s.id) ?? [],
      };
    });
    const states = deriveGoalCriteria(criteria, runs);
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
        };
      }),
      inReview: goalInReview(criteria, states),
      waitingOn: deriveWaitingOn(sources),
    });
  }
  return out;
}

/** The kind of work, read tolerantly (a value no option declares reads as none). */
export function readTrackWorkKind(v: unknown): TrackWorkKind | null {
  return isTrackWorkKind(v) ? v : null;
}

/** The uncertainty, read tolerantly. */
export function readTrackUncertainty(v: unknown): TrackUncertainty | null {
  return isTrackUncertainty(v) ? v : null;
}
