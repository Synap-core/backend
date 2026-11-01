/**
 * THE DELIVERED DIGEST (plan d679e92c C9, wave 065982de W3-notify): once a day
 * per person, what agents DELIVERED for them since the last digest. Nothing
 * told the person work was delivered (research 67f49747 P7): no push and no
 * digest when a PR merged or a session closed.
 *
 * NOT A SECOND PRODUCER. It is raised by the morning brief's own pass
 * (`runMorningBriefs`, the `morning-brief` queue, every 15 minutes), for the
 * same people, at the same time on their clock, held by the same kill switch
 * and snooze (`proactivePostHeldBy`). Its own off switch is its push category
 * (`delivered-digest`, `@synap-core/types/push`), not the brief's `enabled`:
 * a person who turned the brief off has not said they want no news of what
 * shipped.
 *
 * ITS OWN CLASS: passive, outside the 3-a-day interruption budget (it is in
 * `PUSH_CAP_EXEMPT_CATEGORIES`, so it is neither held back nor counted), and
 * `informational` in needs-you (it never waits on the person).
 *
 * WHAT COUNTS AS DELIVERED, only from facts the pod recorded, each with its
 * time (an outcome whose delivery time was never recorded is not guessed):
 *   - PRs merged: the `dev.pr_merged` facts of the person's sessions merged
 *     into the default branch (`intoDefault`, founder F3), and their PR
 *     outcomes met since; one PR counts once;
 *   - commits landed: their commit outcomes met since;
 *   - outcomes met: their other deliverables met since (not `fact` outcomes,
 *     which are checks, and not withdrawn ones);
 *   - sessions closed: their WORK sessions closed (delivered, not cancelled
 *     or failed) since.
 * "Met since" = the time the pod stamped the delivery: the evidence verdict
 * (`satisfiedByEvidence.at`) or the person's attestation (`attestedAt`).
 *
 * SINCE THE LAST DIGEST: the newest digest row of the person (read or not),
 * else the last day; never further back than a week.
 *
 * ONCE A DAY, held like the brief: a digest raised in the last 20 hours means
 * today's is sent, and the door's dedupe window holds one open row per
 * person-day (`delivered-digest:<YYYY-MM-DD>`). NOTHING DELIVERED, NOTHING
 * SENT. A read that FAILS skips the person (counted, logged) and the next
 * tick retries: a failed read is never "nothing delivered".
 */

import {
  and,
  db as defaultDb,
  desc,
  drizzleSql,
  eq,
  events,
  focusSessions,
  gte,
  notifications,
} from "@synap/database";
import {
  DEV_LOOP_EVENT_TYPES,
  parsePullRequestRef,
  pullRequestKey,
} from "@synap-core/types";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { sessionKindWhere } from "../focus-sessions/session-kind.js";

type Database = typeof defaultDb;

/** The registry type — lowercase `notificationType` so the producer scan sees it. */
const notificationType = "ai.proactive.delivered_digest" as const;
export const DELIVERED_DIGEST_TYPE = notificationType;

const HOUR_MS = 3_600_000;
/** With no digest before, the digest covers the last day. */
export const DELIVERED_FIRST_LOOKBACK_MS = 24 * HOUR_MS;
/** Never further back than this, however old the last digest. */
export const DELIVERED_MAX_LOOKBACK_MS = 7 * 24 * HOUR_MS;
/** Sessions read per person per digest; hitting it makes the counts a floor. */
export const DELIVERED_SESSIONS_CAP = 500;
/** PR facts read per person per digest. */
export const DELIVERED_PR_FACTS_CAP = 500;
/** Closed sessions the body names. */
const NAMED_MAX = 3;
/** A named session longer than this is cut. */
const ITEM_MAX = 60;

export interface DeliveredFacts {
  prsMerged: number;
  commitsLanded: number;
  outcomesMet: number;
  sessionsClosed: number;
  /** The closed sessions' titles, newest first (at most a few). */
  closedTitles: string[];
  /** A read hit its cap: every count is a floor. */
  floor: boolean;
}

// ── Pure: what the digest says ──────────────────────────────────────────────

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > ITEM_MAX ? `${t.slice(0, ITEM_MAX - 1).trimEnd()}…` : t;
}

/** The digest in plain words; `null` when nothing was delivered. */
export function composeDeliveredDigest(
  f: DeliveredFacts
): { title: string; body: string } | null {
  const plus = f.floor ? "+" : "";
  const parts: string[] = [];
  if (f.prsMerged > 0)
    parts.push(
      `${plural(f.prsMerged, "pull request", "pull requests")}${plus} merged`
    );
  if (f.commitsLanded > 0)
    parts.push(`${plural(f.commitsLanded, "commit", "commits")}${plus} landed`);
  if (f.outcomesMet > 0)
    parts.push(
      `${plural(f.outcomesMet, "outcome", "outcomes")}${plus} delivered`
    );
  if (f.sessionsClosed > 0)
    parts.push(
      `${plural(f.sessionsClosed, "session", "sessions")}${plus} closed`
    );
  if (parts.length === 0) return null;
  const lines = [`${parts.join(", ")}.`];
  const named = f.closedTitles.map(clip).filter(Boolean).slice(0, NAMED_MAX);
  if (named.length > 0) lines.push(`Closed: ${named.join(" · ")}`);
  return { title: "Delivered since your last digest", body: lines.join("\n") };
}

// ── Pure: what counts ───────────────────────────────────────────────────────

/** When the pod stamped this outcome delivered; null when it never did (or did not record when). */
export function outcomeMetAt(o: unknown): number | null {
  if (!o || typeof o !== "object") return null;
  const s = o as {
    status?: unknown;
    retiredAt?: unknown;
    satisfiedByEvidence?: { at?: unknown } | null;
    attestedAt?: unknown;
  };
  if (s.status !== "done" || s.retiredAt) return null;
  const times = [s.satisfiedByEvidence?.at, s.attestedAt]
    .filter((t): t is string => typeof t === "string")
    .map((t) => Date.parse(t))
    .filter((t) => Number.isFinite(t));
  return times.length > 0 ? Math.max(...times) : null;
}

type OutcomeClass =
  | { kind: "pr"; key: string }
  | { kind: "commit"; key: string }
  | { kind: "outcome" }
  | { kind: "skip" };

const COMMIT_URL = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/commit\/[0-9a-f]+/i;

/** A met outcome is a PR, a commit, another deliverable, or not counted (a fact). */
export function classifyOutcome(o: unknown): OutcomeClass {
  const s = (o ?? {}) as {
    kind?: unknown;
    key?: unknown;
    label?: unknown;
    ref?: { url?: unknown } | null;
  };
  const url = typeof s.ref?.url === "string" ? s.ref.url : null;
  const pr = url ? parsePullRequestRef(url) : null;
  if (pr) return { kind: "pr", key: pullRequestKey(pr) };
  if (s.kind === "commit" || (url && COMMIT_URL.test(url))) {
    return {
      kind: "commit",
      key: (url ?? String(s.key ?? s.label ?? "")).toLowerCase(),
    };
  }
  if (s.kind === "fact") return { kind: "skip" };
  return { kind: "outcome" };
}

/** One session row as {@link foldDelivered} reads it. */
export interface DeliveredSessionRow {
  id: string;
  title: string | null;
  goal: string | null;
  status: string;
  closedAt: Date | string | null;
  expectedOutputs: unknown;
}

/** Pure: the facts from the person's sessions and their merged-PR facts. */
export function foldDelivered(
  sessions: readonly DeliveredSessionRow[],
  mergedPrKeys: readonly string[],
  since: Date,
  floor: boolean
): DeliveredFacts {
  const t0 = since.getTime();
  const prs = new Set(mergedPrKeys);
  const commits = new Set<string>();
  let outcomesMet = 0;
  const closed: Array<{ at: number; title: string }> = [];
  for (const s of sessions) {
    for (const o of Array.isArray(s.expectedOutputs) ? s.expectedOutputs : []) {
      const at = outcomeMetAt(o);
      if (at === null || at < t0) continue;
      const c = classifyOutcome(o);
      if (c.kind === "pr") prs.add(c.key);
      else if (c.kind === "commit") commits.add(c.key);
      else if (c.kind === "outcome") outcomesMet++;
    }
    const closedAt = s.closedAt ? new Date(s.closedAt).getTime() : NaN;
    if (s.status === "closed" && closedAt >= t0) {
      closed.push({ at: closedAt, title: resolveSessionTitle(s) });
    }
  }
  closed.sort((a, b) => b.at - a.at);
  return {
    prsMerged: prs.size,
    commitsLanded: commits.size,
    outcomesMet,
    sessionsClosed: closed.length,
    closedTitles: closed.map((c) => c.title).filter(Boolean),
    floor,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The newest digest raised for this person (read or not), or null. THROWS. */
export async function readLastDigestAt(
  database: Database,
  userId: string
): Promise<Date | null> {
  const [row] = await database
    .select({ at: notifications.createdAt })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, notificationType)
      )
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  return row?.at ? new Date(row.at) : null;
}

/** Since when the digest reports: the last digest, else a day, at most a week back. */
export function digestSince(now: Date, lastDigestAt: Date | null): Date {
  const floor = now.getTime() - DELIVERED_MAX_LOOKBACK_MS;
  const from = lastDigestAt
    ? lastDigestAt.getTime()
    : now.getTime() - DELIVERED_FIRST_LOOKBACK_MS;
  return new Date(Math.max(from, floor));
}

/** What agents delivered for `userId` since `since` (see the header). THROWS. */
export async function readDeliveredSince(
  database: Database,
  userId: string,
  since: Date
): Promise<DeliveredFacts> {
  const sinceIso = since.toISOString();
  const [sessions, prFacts] = await Promise.all([
    // A session that delivered something since `since` was written since
    // then: its `updated_at` moved.
    database
      .select({
        id: focusSessions.id,
        title: focusSessions.title,
        goal: focusSessions.goal,
        status: focusSessions.status,
        closedAt: focusSessions.closedAt,
        expectedOutputs: focusSessions.expectedOutputs,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          gte(focusSessions.updatedAt, since),
          sessionKindWhere("work")
        )
      )
      .orderBy(desc(focusSessions.updatedAt))
      .limit(DELIVERED_SESSIONS_CAP + 1),
    database
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.type, DEV_LOOP_EVENT_TYPES.prMerged),
          drizzleSql`${events.timestamp} >= ${sinceIso}::timestamptz`,
          drizzleSql`(${events.data}->>'intoDefault') = 'true'`,
          drizzleSql`${events.data}->>'sessionId' IN (
            SELECT ${focusSessions.id}::text FROM ${focusSessions}
            WHERE ${focusSessions.userId} = ${userId})`
        )
      )
      .limit(DELIVERED_PR_FACTS_CAP + 1),
  ]);
  const prKeys = prFacts.flatMap((r) => {
    const d = (r.data ?? {}) as { url?: unknown };
    const ref = typeof d.url === "string" ? parsePullRequestRef(d.url) : null;
    return ref ? [pullRequestKey(ref)] : [];
  });
  const floor =
    sessions.length > DELIVERED_SESSIONS_CAP ||
    prFacts.length > DELIVERED_PR_FACTS_CAP;
  return foldDelivered(
    sessions.slice(0, DELIVERED_SESSIONS_CAP),
    prKeys,
    since,
    floor
  );
}
