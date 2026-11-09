/**
 * PR → SESSION — which focus session(s) a pull request belongs to, so a fact
 * about the PR (merged, closed) can move the work it is part of.
 *
 * Two joins, in order of trust (plan v5 T2):
 *   1. an OUTCOME whose `ref.url` is the PR — the deliverable the session
 *      declared (`pr-<repo>-<n>`, kind `pull_request`, the work-units rule).
 *      Every matching slot of every matching session is returned;
 *   2. else the PR body's `Pod session: <uuid>` line (or the `sessionId` a
 *      producer already parsed from it) — the convention agents write when
 *      they open the PR. The slot is then the one pointing at the PR, else the
 *      one with the conventional key; a session with neither is returned with
 *      `slotKey: null` (the PR names the session, the session never declared
 *      the PR as an outcome).
 *
 * OWNER-FLOORED: only the sessions of `userId` (the observation's principal,
 * i.e. the person whose key posted it) — the same floor every session door
 * applies. A PR body naming someone else's session resolves to nothing.
 *
 * A failed read THROWS: "no session" and "could not look" are different facts.
 */

import {
  and,
  db,
  drizzleSql,
  eq,
  focusSessions,
  inArray,
} from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  DEV_LOOP_EVENT_TYPES,
  parsePullRequestRef,
  podSessionIdFromBody,
  pullRequestOutcomeKey,
  samePullRequest,
  type PullRequestRef,
} from "@synap-core/types";
import { OPEN_SESSION_STATUSES } from "@synap-core/types/focus-sessions";
import { deriveSlotKeys } from "../focus-sessions/slot-keys.js";
import { pullRequestsInDeploy } from "./pr-state.js";

export type PrSessionVia = "outcome_ref" | "pr_body";

export interface PrSessionMatch {
  sessionId: string;
  /** The slot that IS the PR — `null` when the session never declared it. */
  slotKey: string | null;
  via: PrSessionVia;
  /** The slot is already done or withdrawn (a replayed event, a manual close). */
  settled: boolean;
}

function readSlots(raw: unknown): ExpectedOutput[] {
  return Array.isArray(raw) ? (raw as ExpectedOutput[]) : [];
}

function slotPointsAt(slot: ExpectedOutput | undefined, pr: PullRequestRef) {
  const ref = slot?.ref;
  if (!ref || !("url" in ref) || typeof ref.url !== "string") return false;
  const parsed = parsePullRequestRef(ref.url);
  return parsed !== null && samePullRequest(parsed, pr);
}

function isSettled(slot: ExpectedOutput | undefined): boolean {
  return slot?.status === "done" || slot?.retiredAt != null;
}

/** The slots of ONE session that are this PR. Pure. */
export function slotsForPullRequest(
  slots: readonly ExpectedOutput[],
  pr: PullRequestRef
): Array<{ key: string; settled: boolean }> {
  const keys = deriveSlotKeys(slots);
  const out: Array<{ key: string; settled: boolean }> = [];
  slots.forEach((slot, i) => {
    const key = keys[i];
    if (key && slotPointsAt(slot, pr)) {
      out.push({ key, settled: isSettled(slot) });
    }
  });
  return out;
}

export async function resolvePullRequestSessions(input: {
  userId: string;
  pr: PullRequestRef;
  body?: string | null;
  sessionId?: string | null;
}): Promise<PrSessionMatch[]> {
  const { userId, pr } = input;

  // 1. Outcomes pointing at the PR. The text prefilter narrows the scan to
  //    rows that mention `/pull/<n>` at all; the exact match (repo, number,
  //    any spelling) is `slotsForPullRequest`, never the SQL.
  const candidates = await db
    .select({
      id: focusSessions.id,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        drizzleSql`${focusSessions.expectedOutputs}::text ILIKE ${`%/pull/${pr.number}%`}`
      )
    );
  const byRef: PrSessionMatch[] = [];
  for (const row of candidates) {
    for (const slot of slotsForPullRequest(
      readSlots(row.expectedOutputs),
      pr
    )) {
      byRef.push({
        sessionId: row.id,
        slotKey: slot.key,
        via: "outcome_ref",
        settled: slot.settled,
      });
    }
  }
  if (byRef.length > 0) return byRef;

  // 2. The session the PR body names.
  const named =
    input.sessionId?.toLowerCase() ?? podSessionIdFromBody(input.body);
  if (!named) return [];
  const [session] = await db
    .select({
      id: focusSessions.id,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(and(eq(focusSessions.id, named), eq(focusSessions.userId, userId)))
    .limit(1);
  if (!session) return [];
  const slots = readSlots(session.expectedOutputs);
  const pointing = slotsForPullRequest(slots, pr);
  if (pointing.length > 0) {
    return pointing.map((s) => ({
      sessionId: session.id,
      slotKey: s.key,
      via: "pr_body" as const,
      settled: s.settled,
    }));
  }
  const conventional = pullRequestOutcomeKey(pr);
  const keys = deriveSlotKeys(slots);
  const index = keys.indexOf(conventional);
  return [
    {
      sessionId: session.id,
      slotKey: index === -1 ? null : conventional,
      via: "pr_body",
      settled: index === -1 ? false : isSettled(slots[index]),
    },
  ];
}

/**
 * The ONE session a dev-loop fact is about, to stamp on the fact as
 * `data.sessionId` before automations match it — so an automation keyed on
 * `trigger.payload.data.sessionId` fires for a PR that names its session only
 * through an outcome ref (no `Pod session:` line), for a `ci.started` /
 * `ci.finished` of that PR (the contract's `pr` field) and for its
 * `dev.merge_queued`. Same resolver, same owner floor as the
 * sweeper.
 *
 * `null` when the fact already carries a session, is not about a PR, or the
 * PR resolves to no session or to SEVERAL (an automation acts on one session;
 * guessing which would move the wrong one — the sweeper still reaches each).
 */
export async function sessionForDevLoopFact(input: {
  userId: string;
  type: string;
  data: Record<string, unknown>;
}): Promise<string | null> {
  const { data } = input;
  if (typeof data.sessionId === "string" && data.sessionId.length > 0) {
    return null;
  }
  const repo = typeof data.repo === "string" ? data.repo : null;
  const number =
    input.type === DEV_LOOP_EVENT_TYPES.ciFinished ||
    input.type === DEV_LOOP_EVENT_TYPES.ciStarted
      ? data.pr
      : input.type === DEV_LOOP_EVENT_TYPES.prOpened ||
          input.type === DEV_LOOP_EVENT_TYPES.prMerged ||
          input.type === DEV_LOOP_EVENT_TYPES.prClosed ||
          input.type === DEV_LOOP_EVENT_TYPES.mergeQueued
        ? data.number
        : null;
  if (!repo || typeof number !== "number") return null;
  const matches = await resolvePullRequestSessions({
    userId: input.userId,
    pr: { repo, number },
    body: typeof data.body === "string" ? data.body : null,
  });
  const ids = new Set(matches.map((m) => m.sessionId));
  return ids.size === 1 ? [...ids][0]! : null;
}

/** Every PR a session's slots point at (`ref.url`), any slot kind. Pure. */
export function pullRequestsOfSlots(
  slots: readonly ExpectedOutput[]
): PullRequestRef[] {
  const out: PullRequestRef[] = [];
  for (const slot of slots) {
    const ref = slot?.ref;
    if (!ref || !("url" in ref) || typeof ref.url !== "string") continue;
    const pr = parsePullRequestRef(ref.url);
    if (pr && !out.some((o) => samePullRequest(o, pr))) out.push(pr);
  }
  return out;
}

/**
 * The OPEN sessions (`OPEN_SESSION_STATUSES`) of `userId` whose recorded PR
 * (an outcome whose `ref.url` is the PR — join 1 above) THIS deploy contains,
 * to stamp on a `dev.deployed` fact as `data.sessionIds` before automations
 * match it — so "the pod deploys a build containing this session's PR → its
 * stage is verified" is stored config (a `loop` over `trigger.data.sessionIds`
 * into `session_update`). Containment is the fold's (`pullRequestsInDeploy`),
 * never a second check. A deploy contains every older merge too, so a session
 * already moved is listed again: the advance is then a no-op.
 *
 * Sorted ids; `[]` when the payload is not a deploy or nothing matches.
 * OWNER-FLOORED like the PR resolver. A failed read THROWS.
 */
export async function sessionsInDeploy(input: {
  userId: string;
  data: Record<string, unknown>;
  occurredAt?: Date;
}): Promise<string[]> {
  const { data } = input;
  if (typeof data.sha !== "string" || data.sha.length === 0) return [];
  const repo = typeof data.repo === "string" ? data.repo : null;
  const candidates = await db
    .select({
      id: focusSessions.id,
      expectedOutputs: focusSessions.expectedOutputs,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, input.userId),
        inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
        drizzleSql`${focusSessions.expectedOutputs}::text ILIKE ${"%/pull/%"}`
      )
    );
  const prsBySession = new Map<string, PullRequestRef[]>();
  for (const row of candidates) {
    const prs = pullRequestsOfSlots(readSlots(row.expectedOutputs)).filter(
      // A build of one repo carries only that repo's merges.
      (pr) => !repo || samePullRequest(pr, { repo, number: pr.number })
    );
    if (prs.length > 0) prsBySession.set(row.id, prs);
  }
  if (prsBySession.size === 0) return [];
  const contained = await pullRequestsInDeploy(
    [...prsBySession.values()].flat(),
    {
      type: DEV_LOOP_EVENT_TYPES.deployed,
      timestamp: input.occurredAt ?? new Date(),
      data,
    },
    { userId: input.userId, roster: false }
  );
  if (contained.length === 0) return [];
  return [...prsBySession]
    .filter(([, prs]) =>
      prs.some((pr) => contained.some((c) => samePullRequest(c, pr)))
    )
    .map(([id]) => id)
    .sort();
}
