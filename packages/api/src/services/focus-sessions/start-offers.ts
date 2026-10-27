/**
 * START OFFERS (plan v5 F5/F6, lane be-context) — what an AI start door hands
 * back beside the new session, so work lands on the goal it serves and next to
 * the work already running, instead of as one more free session.
 *
 * Measured 2026-10-26: 43 of 51 open work sessions served no goal, and one aim
 * ("the founder sees all agent work in one place") was held by 5 open sessions
 * in 5 conversations. The start door ranked playbooks only; `trackId` was
 * taken only if the agent already knew it.
 *
 *  - `goals`    — the project's OPEN goals (only when the start named no
 *                 `trackId`) that share a word with the session, best match
 *                 first: "this may serve goal X — file it with `trackId`".
 *                 Read through `listOpenGoalRows`, the reader orient's
 *                 `openGoals` uses (orient lists every open goal).
 *  - `sessions` — OPEN sessions on close work in the same goal (when filed
 *                 into one) or the same project: "continue one of these?".
 *                 Same similarity as the twin matcher (`tokenSetOverlap`), at a
 *                 lower bar: the twin matcher DEDUPS (≥ 0.8, exact work); this
 *                 only SUGGESTS.
 *
 * SUGGEST-ONLY, like the playbook offer: nothing is joined, adopted or filed.
 * Each part is its own section; a failed read is `unavailable`, never an empty
 * offer, and never fails the start it rides on. Nothing to offer in either
 * part: no block at all (rv-be-needs S6 — an empty block was noise on every
 * start, and its hint told the agent to cancel the session it had just begun).
 */
import {
  db,
  focusSessions,
  and,
  eq,
  ne,
  or,
  inArray,
  desc,
  tokenSetOverlap,
} from "@synap/database";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { createLogger } from "@synap-core/core";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import { sessionKindWhere } from "./session-kind.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { listOpenGoalRows } from "../discover/open-goals.js";

const logger = createLogger({ module: "focus-sessions/start-offers" });

/** Offers listed per part. */
export const START_OFFERS_MAX = 5;
/** Open goals of one project read for ranking. */
const GOALS_SCAN = 50;
/** Open sessions of one scope read for ranking (a scope is small by nature). */
const SESSIONS_SCAN = 200;
/**
 * Token-set overlap at/above which an open session is OFFERED. Lower than the
 * twin matcher's `NEAR_MATCH_THRESHOLD` (0.8) on purpose: that bar decides a
 * duplicate; this one only puts a session in front of the agent. Measured
 * 2026-10-26: no open pair reached 0.31, so 0.8 never surfaced a sibling.
 */
export const NEAR_TWIN_OFFER_MIN = 0.2;

type Unavailable = { status: "unavailable"; reason: string };
/** The offers, or why they could not be read at all — never folded into "none". */
export type StartOffersRead = StartOffers | Unavailable;

export interface StartGoalOffer {
  id: string;
  name: string;
  status: string;
  endState: string | null;
  /** Overlap of the session's words with the goal's name + end state. */
  score: number;
}

export interface StartSessionOffer {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  trackId: string | null;
  score: number;
}

export interface StartOffers {
  /** Absent when the start named a goal, or has no project to look in. */
  goals?:
    { status: "ok"; total: number; items: StartGoalOffer[] } | Unavailable;
  sessions:
    | {
        status: "ok";
        scope: "goal" | "project";
        total: number;
        items: StartSessionOffer[];
      }
    | Unavailable;
  /** One line: what to do with them. Suggestions only — nothing was applied. */
  hint: string;
}

const words = (...parts: Array<string | null | undefined>): string =>
  parts.filter((p): p is string => !!p && p.trim() !== "").join(" ");

/**
 * The offers for a session just started. `undefined` when there is no scope to
 * look in (no project and no goal), or when both parts READ and found nothing
 * — never when a part failed (that part says `unavailable`).
 */
export async function readStartOffers(p: {
  userId: string;
  sessionId: string;
  projectId: string | null;
  trackId: string | null;
  title: string | null;
  goal: string;
  database?: typeof db;
}): Promise<StartOffers | undefined> {
  if (!p.projectId && !p.trackId) return undefined;
  const database = p.database ?? db;
  const said = words(p.title, p.goal);

  const goals: StartOffers["goals"] =
    !p.trackId && p.projectId
      ? await listOpenGoalRows({
          userId: p.userId,
          projectId: p.projectId,
          limit: GOALS_SCAN,
        })
          .then((rows) => {
            // Only a goal that shares a word with the session (score > 0),
            // best match first: one the words miss entirely is noise here.
            const ranked = rows
              .map((g) => ({
                id: g.id,
                name: g.name,
                status: g.status,
                endState: g.endState,
                score: tokenSetOverlap(said, words(g.name, g.endState)),
              }))
              .filter((g) => g.score > 0)
              .sort((a, b) => b.score - a.score);
            return {
              status: "ok" as const,
              total: ranked.length,
              items: ranked.slice(0, START_OFFERS_MAX),
            };
          })
          .catch((err): Unavailable => {
            logger.warn({ err }, "start offers: goals NOT read");
            return {
              status: "unavailable",
              reason: "The project's open goals could not be read.",
            };
          })
      : undefined;

  const scope: "goal" | "project" = p.trackId ? "goal" : "project";
  const sessions: StartOffers["sessions"] = await database
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
      trackId: focusSessions.trackId,
    })
    .from(focusSessions)
    .where(
      and(
        p.trackId
          ? eq(focusSessions.trackId, p.trackId)
          : eq(focusSessions.projectId, p.projectId!),
        ne(focusSessions.id, p.sessionId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        // A receipt groups an agent's writes; it is not work to continue.
        or(sessionKindWhere("work"), sessionKindWhere("run")),
        sessionReadableWhere({ userId: p.userId })
      )
    )
    // SESSION-KIND-LENS-EXEMPT: a suggestion list of {id, title, score}, never a page of session rows; receipts excluded in the WHERE.
    .orderBy(desc(focusSessions.updatedAt))
    .limit(SESSIONS_SCAN)
    .then((rows) => {
      const near = rows
        .map((r) => ({
          id: r.id,
          title: resolveSessionTitle(r),
          status: r.status,
          statusLabel: resolveStatusLabel(r.status),
          trackId: r.trackId ?? null,
          score: tokenSetOverlap(said, words(r.title, r.goal)),
        }))
        .filter((r) => r.score >= NEAR_TWIN_OFFER_MIN)
        .sort((a, b) => b.score - a.score);
      return {
        status: "ok" as const,
        scope,
        total: near.length,
        items: near.slice(0, START_OFFERS_MAX),
      };
    })
    .catch((err): Unavailable => {
      logger.warn({ err }, "start offers: sessions NOT read");
      return {
        status: "unavailable",
        reason: "The open sessions on close work could not be read.",
      };
    });

  const found = (part?: { status: "ok"; total: number } | Unavailable) =>
    !!part && (part.status === "unavailable" || part.total > 0);
  if (!found(goals) && !found(sessions)) return undefined;
  return {
    ...(goals ? { goals } : {}),
    sessions,
    hint: "Suggestions only — nothing was applied. If this work serves one of `goals`, file it: update_session with trackId. If one of `sessions` is the same work, continue it (and close this one with complete_session, terminalStatus cancelled) instead of running two.",
  };
}
