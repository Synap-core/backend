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
 *  - `homes`    — only for a start that landed in NO project and no goal
 *                 (structural plan S5): up to 3 projects or goals it may
 *                 belong in, each with the FACTS that point there — the
 *                 subject's projects, past sessions from the same folder, this
 *                 agent's recent filings, shared words. Filing stays the
 *                 person's call (decision 2026-08-04: never auto-filed; the
 *                 project ladder refuses to guess, `resolve-session-project.ts`),
 *                 so a home is offered, never applied.
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
  projects,
  relations,
  and,
  eq,
  ne,
  or,
  gte,
  inArray,
  isNotNull,
  arrayContains,
  count,
  desc,
  drizzleSql,
  tokenSetOverlap,
  projectNameTokens,
  BELONGS_TO_PROJECT,
} from "@synap/database";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { createLogger } from "@synap-core/core";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import { sessionKindWhere } from "./session-kind.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { AccessContext, scopedDb } from "../../access/index.js";
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
/** Homes offered to an unfiled start (structural plan S5). */
export const START_HOMES_MAX = 3;
/** Active projects read for the homes ranking (a pod holds tens, not hundreds). */
const PROJECTS_SCAN = 200;
/** How far back "sessions from this folder" looks. */
const FOLDER_DAYS = 30;
/** How far back "this agent's recent filings" looks. */
const AGENT_DAYS = 7;

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

/**
 * A place an unfiled session may belong. A goal also names its project:
 * filing into the goal files the project too.
 */
export interface StartHomeOffer {
  kind: "project" | "goal";
  projectId: string;
  projectName: string;
  /** Present for a goal. */
  trackId?: string;
  trackName?: string;
  /** Why it is offered: facts, one line each. No score is shown. */
  reasons: string[];
}

export interface StartOffers {
  /** Absent when the start named a goal, or has no project to look in. */
  goals?:
    { status: "ok"; total: number; items: StartGoalOffer[] } | Unavailable;
  /** Absent on an unfiled start: there is no project or goal to look in. */
  sessions?:
    | {
        status: "ok";
        scope: "goal" | "project";
        total: number;
        items: StartSessionOffer[];
      }
    | Unavailable;
  /** Present only on an unfiled start (no project, no goal). */
  homes?:
    { status: "ok"; total: number; items: StartHomeOffer[] } | Unavailable;
  /** One line: what to do with them. Suggestions only — nothing was applied. */
  hint: string;
}

const words = (...parts: Array<string | null | undefined>): string =>
  parts.filter((p): p is string => !!p && p.trim() !== "").join(" ");

/**
 * The offers for a session just started. `undefined` when every part READ and
 * found nothing — never when a part failed (that part says `unavailable`). A
 * start with no project and no goal gets the `homes` part alone.
 */
export async function readStartOffers(p: {
  userId: string;
  sessionId: string;
  projectId: string | null;
  trackId: string | null;
  title: string | null;
  goal: string;
  /** The entity the session is about: its projects are a home's fact. */
  subjectEntityId?: string | null;
  /** The folder the session was started from (`metadata.conversationCwd`). */
  conversationCwd?: string | null;
  /** The agent that started it: its recent filings are a home's fact. */
  agentUserId?: string | null;
  database?: typeof db;
}): Promise<StartOffers | undefined> {
  const database = p.database ?? db;
  const said = words(p.title, p.goal);
  if (!p.projectId && !p.trackId) {
    const homes = await readStartHomes({ ...p, said, database }).catch(
      (err): Unavailable => {
        logger.warn({ err }, "start offers: homes NOT read");
        return {
          status: "unavailable",
          reason:
            "The projects and goals this work may belong in could not be read.",
        };
      }
    );
    if (homes.status === "ok" && homes.total === 0) return undefined;
    return {
      homes,
      hint: "Suggestions only — nothing was applied. This session is in no project. If it belongs in one of `homes`, file it: update_session with its projectId (a project) or trackId (a goal). Which project work belongs to is the person's call: ask when the reasons do not settle it.",
    };
  }

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

/** The words two texts share, as `tokenSetOverlap` counts them. */
function sharedWords(a: string, b: string): string[] {
  const other = projectNameTokens(b);
  return [...projectNameTokens(a)].filter((t) => other.has(t));
}

const quoteWords = (ws: string[]): string =>
  ws
    .slice(0, 3)
    .map((w) => `"${w}"`)
    .join(", ");

const sessionsWord = (n: number): string =>
  n === 1 ? "1 session" : `${n} sessions`;

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 86_400_000);

/**
 * HOMES — where a session that landed in no project may belong (structural
 * plan S5). Facts only, each one a reason the caller is shown:
 *  - its SUBJECT's projects (`belongs_to_project` of `subjectEntityId`);
 *  - the caller's sessions started from the SAME FOLDER in the last 30 days
 *    (`metadata.conversationCwd`), by project;
 *  - THIS AGENT's sessions of the last 7 days (`agentIds`), by project;
 *  - SHARED WORDS with a project's name, or a goal's name and end state —
 *    through `tokenSetOverlap`, the one scorer (no description: Jaccard on a
 *    long text scores near zero).
 * Ranked by how many facts point at a place, then by shared words; at most
 * {@link START_HOMES_MAX}. Projects come through the `projects` VisibilityRule
 * (active ones), goals through `listOpenGoalRows`, sessions are the caller's
 * own work and runs; a fact about a project the caller cannot see is dropped.
 * THROWS on a failed read: the caller says `unavailable`.
 */
async function readStartHomes(p: {
  userId: string;
  sessionId: string;
  said: string;
  subjectEntityId?: string | null;
  conversationCwd?: string | null;
  agentUserId?: string | null;
  database: typeof db;
}): Promise<{ status: "ok"; total: number; items: StartHomeOffer[] }> {
  const { database } = p;
  const visible = await scopedDb(
    AccessContext.from({ userId: p.userId })
  ).findMany<{ id: string; name: string }>(projects, {
    where: eq(projects.status, "active"),
    orderBy: [desc(projects.updatedAt)],
    limit: PROJECTS_SCAN,
  });
  const projectNames = new Map(visible.map((r) => [r.id, r.name]));

  const facts = new Map<string, string[]>();
  const addFact = (projectId: string | null, reason: string) => {
    if (!projectId || !projectNames.has(projectId)) return;
    facts.set(projectId, [...(facts.get(projectId) ?? []), reason]);
  };

  if (p.subjectEntityId) {
    const rows = await database
      .select({ projectId: relations.targetEntityId })
      .from(relations)
      .where(
        and(
          eq(relations.type, BELONGS_TO_PROJECT),
          eq(relations.sourceEntityId, p.subjectEntityId)
        )
      );
    for (const r of new Set(rows.map((x) => x.projectId))) {
      addFact(r, "The session's subject is in this project.");
    }
  }

  // The caller's own filed work, never this session; a receipt groups an
  // agent's writes and says nothing about where work belongs.
  const ownFiledWork = and(
    eq(focusSessions.userId, p.userId),
    ne(focusSessions.id, p.sessionId),
    isNotNull(focusSessions.projectId),
    or(sessionKindWhere("work"), sessionKindWhere("run"))
  );
  if (p.conversationCwd) {
    const rows = await database
      .select({ projectId: focusSessions.projectId, n: count() })
      .from(focusSessions)
      .where(
        and(
          ownFiledWork,
          gte(focusSessions.createdAt, daysAgo(FOLDER_DAYS)),
          drizzleSql`${focusSessions.metadata}->>'conversationCwd' = ${p.conversationCwd}`
        )
      )
      .groupBy(focusSessions.projectId);
    for (const r of rows) {
      addFact(
        r.projectId,
        `${sessionsWord(Number(r.n))} started from this folder in the last ${FOLDER_DAYS} days ${Number(r.n) === 1 ? "is" : "are"} in this project.`
      );
    }
  }
  if (p.agentUserId) {
    const rows = await database
      .select({ projectId: focusSessions.projectId, n: count() })
      .from(focusSessions)
      .where(
        and(
          ownFiledWork,
          gte(focusSessions.createdAt, daysAgo(AGENT_DAYS)),
          arrayContains(focusSessions.agentIds, [p.agentUserId])
        )
      )
      .groupBy(focusSessions.projectId);
    for (const r of rows) {
      addFact(
        r.projectId,
        `${sessionsWord(Number(r.n))} this agent ran in the last ${AGENT_DAYS} days ${Number(r.n) === 1 ? "is" : "are"} in this project.`
      );
    }
  }

  const ranked: Array<{ home: StartHomeOffer; score: number }> = [];
  for (const [projectId, projectName] of projectNames) {
    const reasons = [...(facts.get(projectId) ?? [])];
    const score = tokenSetOverlap(p.said, projectName);
    if (score > 0) {
      reasons.push(
        `Shares ${quoteWords(sharedWords(p.said, projectName))} with the project's name.`
      );
    }
    if (reasons.length > 0) {
      ranked.push({
        home: { kind: "project", projectId, projectName, reasons },
        score,
      });
    }
  }
  const goals = await listOpenGoalRows({ userId: p.userId, limit: GOALS_SCAN });
  for (const g of goals) {
    const projectName = projectNames.get(g.projectId);
    const goalWords = words(g.name, g.endState);
    const score = tokenSetOverlap(p.said, goalWords);
    if (!projectName || score === 0) continue;
    ranked.push({
      home: {
        kind: "goal",
        projectId: g.projectId,
        projectName,
        trackId: g.id,
        trackName: g.name,
        reasons: [
          `Shares ${quoteWords(sharedWords(p.said, goalWords))} with the goal.`,
        ],
      },
      score,
    });
  }

  ranked.sort(
    (a, b) =>
      b.home.reasons.length - a.home.reasons.length ||
      b.score - a.score ||
      a.home.projectName.localeCompare(b.home.projectName)
  );
  return {
    status: "ok",
    total: ranked.length,
    items: ranked.slice(0, START_HOMES_MAX).map((r) => r.home),
  };
}
