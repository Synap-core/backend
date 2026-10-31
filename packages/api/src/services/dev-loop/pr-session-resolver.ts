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

import { and, db, drizzleSql, eq, focusSessions } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  DEV_LOOP_EVENT_TYPES,
  parsePullRequestRef,
  podSessionIdFromBody,
  pullRequestOutcomeKey,
  samePullRequest,
  type PullRequestRef,
} from "@synap-core/types";
import { deriveSlotKeys } from "../focus-sessions/slot-keys.js";

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
 * through an outcome ref (no `Pod session:` line), and for a `ci.finished` of
 * that PR (the contract's `pr` field). Same resolver, same owner floor as the
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
    input.type === DEV_LOOP_EVENT_TYPES.ciFinished
      ? data.pr
      : input.type === DEV_LOOP_EVENT_TYPES.prOpened ||
          input.type === DEV_LOOP_EVENT_TYPES.prMerged ||
          input.type === DEV_LOOP_EVENT_TYPES.prClosed
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
