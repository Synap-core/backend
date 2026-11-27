/**
 * readPullRequestStates — THE read of what the pod knows about pull requests:
 * the dev-loop facts it recorded (`dev.pr_*`, `dev.merge_queued`,
 * `ci.started` / `ci.finished`, `dev.deployed`),
 * under the reader's event floor (`eventVisibleWhere`), folded by the ONE rule
 * (`foldPullRequestState`, `@synap-core/types`).
 *
 * A PR with no recorded fact is ABSENT from the map (an older pod, a repo with
 * no producer): the caller draws nothing, never a guessed "Open". A failed
 * read THROWS, so the caller can say `unavailable` instead of absent.
 *
 * Two queries, both bounded by the PRs asked about: the PR facts (a merge
 * queue entry is one: it names repo and number) first, then
 * the CI runs and deploys that can only be matched once the PR's head and
 * merge shas are known. A deploy is read when it names a merge sha, or, once
 * some PR merged, when it is a build of one of the PRs' repos that says when
 * its commit was made (`builtAt`): the fold decides which merges it contains.
 *
 * The second query is BOUNDED IN TIME (`FOLLOW_UP_LEAD_MS` before the asked
 * PRs' earliest fact), so the `events` hypertable plans and scans only the
 * chunks that can hold those runs and deploys, never every week since the
 * pod began. Identical reads in flight at once share one pair of queries.
 */

import {
  DEV_LOOP_EVENT_TYPES,
  foldPullRequestState,
  pullRequestKey,
  type DevLoopEventRowLike,
  type PullRequestRef,
  type PullRequestStateFacts,
} from "@synap-core/types";
import { db, events } from "@synap/database";
import { and, gte, inArray, or, sql, type SQL } from "drizzle-orm";

import {
  eventVisibleWhere,
  type EventReader,
} from "../../access/event-visibility.js";

export { pullRequestKey };

const PR_TYPES = [
  DEV_LOOP_EVENT_TYPES.prOpened,
  DEV_LOOP_EVENT_TYPES.prMerged,
  DEV_LOOP_EVENT_TYPES.prClosed,
  DEV_LOOP_EVENT_TYPES.mergeQueued,
];

/** A run's start and its end: the fold pairs them per workflow. */
const CI_TYPES = [
  DEV_LOOP_EVENT_TYPES.ciStarted,
  DEV_LOOP_EVENT_TYPES.ciFinished,
];

/**
 * How long before a PR's earliest recorded fact one of its CI runs or deploys
 * can be recorded. A run on the head sha may precede `dev.pr_opened` (the
 * branch's own CI); a deploy's timestamp may precede its `builtAt` and the
 * merge fact by hours. Measured on the founder's pod (2026-11-26, 1121 PRs
 * with CI): the longest lead was 1 day 20 h, none over 7 days. The fold reads
 * nothing older, so this bound changes no state; it lets the hypertable skip
 * every older chunk (planning 19 ms → 1 ms, execution 49 ms → 15 ms).
 */
export const FOLLOW_UP_LEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** Shas are matched on their first 7 characters in SQL, exactly in the fold. */
const SHORT = 7;

function shortSha(sha: unknown): string | null {
  return typeof sha === "string" && sha.length >= SHORT
    ? sha.slice(0, SHORT).toLowerCase()
    : null;
}

const repoOf = sql<string>`lower(${events.data}->>'repo')`;

const FACT_SELECT = {
  type: events.type,
  timestamp: events.timestamp,
  data: events.data,
};

/** The PR facts (`dev.pr_*`, `dev.merge_queued`) of these PRs, under `visible`. */
async function readPullRequestFactRows(
  refs: readonly PullRequestRef[],
  visible: SQL,
  database: typeof db
): Promise<DevLoopEventRowLike[]> {
  return database
    .select(FACT_SELECT)
    .from(events)
    .where(
      and(
        inArray(events.type, PR_TYPES),
        // ONE key per row matched against the asked keys, not one OR arm per
        // PR: with N PRs the arms re-read the row's JSON 2N times (work-release
        // asks ~60). Same match: lowercased repo and number, NULL matches none
        // (a repo name cannot hold `#`).
        inArray(
          sql`${repoOf} || '#' || (${events.data}->>'number')`,
          refs.map((r) => `${r.repo.toLowerCase()}#${r.number}`)
        ),
        visible
      )
    );
}
const shaOf = sql<string>`lower(left(${events.data}->>'sha', ${SHORT}))`;

/**
 * Reads running now, per database and per (reader floor, asked PRs). The
 * needs-you and session pages ask the same PRs from several requests at once
 * (measured on the founder's pod, 2026-11-26: 51 of 85 reads of one 12-PR set
 * started while an identical one was running). A joiner gets the running
 * read's answer; once it settles the entry is gone, so nothing is cached
 * past the read itself and a later call reads again.
 */
const inFlight = new WeakMap<
  object,
  Map<string, Promise<Map<string, PullRequestStateFacts>>>
>();

export async function readPullRequestStates(
  refs: readonly PullRequestRef[],
  reader: EventReader,
  database: typeof db = db
): Promise<Map<string, PullRequestStateFacts>> {
  const unique = new Map(refs.map((r) => [pullRequestKey(r), r]));
  if (unique.size === 0) return new Map();
  const key = JSON.stringify({
    userId: reader.userId,
    roster: reader.roster,
    // `undefined` (every event) and `null` (personal only) are two lenses.
    lens: reader.lens === undefined ? { all: true } : reader.lens,
    prs: [...unique.keys()].sort(),
  });
  let running = inFlight.get(database);
  if (!running) {
    running = new Map();
    inFlight.set(database, running);
  }
  let read = running.get(key);
  if (!read) {
    const reads = running;
    read = readStates(unique, reader, database).finally(() => {
      reads.delete(key);
    });
    running.set(key, read);
  }
  // Each caller gets its own map: one caller's edits never reach another.
  return new Map(await read);
}

async function readStates(
  unique: ReadonlyMap<string, PullRequestRef>,
  reader: EventReader,
  database: typeof db
): Promise<Map<string, PullRequestStateFacts>> {
  const out = new Map<string, PullRequestStateFacts>();
  const visible = eventVisibleWhere(reader);

  const prRows = await readPullRequestFactRows(
    [...unique.values()],
    visible,
    database
  );
  if (prRows.length === 0) return out;

  const repos = [
    ...new Set([...unique.values()].map((r) => r.repo.toLowerCase())),
  ];
  const numbers = [
    ...new Set([...unique.values()].map((r) => String(r.number))),
  ];
  const headShas = new Set<string>();
  const mergeShas = new Set<string>();
  let merged = false;
  for (const row of prRows) {
    if (row.type === DEV_LOOP_EVENT_TYPES.prMerged) merged = true;
    const sha = shortSha((row.data as { sha?: unknown } | null)?.sha);
    if (!sha) continue;
    if (row.type === DEV_LOOP_EVENT_TYPES.prOpened) headShas.add(sha);
    if (row.type === DEV_LOOP_EVENT_TYPES.prMerged) mergeShas.add(sha);
  }

  const ciMatch: SQL[] = [inArray(sql<string>`${events.data}->>'pr'`, numbers)];
  if (headShas.size > 0) ciMatch.push(inArray(shaOf, [...headShas]));
  const followUps: SQL[] = [
    and(
      inArray(events.type, CI_TYPES),
      inArray(repoOf, repos),
      or(...ciMatch)
    )!,
  ];
  if (merged) {
    const deployMatch: SQL[] = [
      and(inArray(repoOf, repos), sql`${events.data}->>'builtAt' is not null`)!,
    ];
    if (mergeShas.size > 0) deployMatch.push(inArray(shaOf, [...mergeShas]));
    followUps.push(
      and(
        sql`${events.type} = ${DEV_LOOP_EVENT_TYPES.deployed}`,
        or(...deployMatch)
      )!
    );
  }
  // No run or deploy of these PRs is recorded long before their first fact
  // (`FOLLOW_UP_LEAD_MS`): the bound lets the hypertable skip older chunks.
  const firstFactAt = prRows.reduce(
    (min, row) => Math.min(min, new Date(row.timestamp).getTime()),
    Infinity
  );
  const since = new Date(firstFactAt - FOLLOW_UP_LEAD_MS);
  const laterRows: DevLoopEventRowLike[] = await database
    .select(FACT_SELECT)
    .from(events)
    .where(and(gte(events.timestamp, since), or(...followUps), visible));

  const rows = [...prRows, ...laterRows];
  for (const [key, ref] of unique) {
    const facts = foldPullRequestState(ref, rows);
    if (facts) out.set(key, facts);
  }
  return out;
}

/**
 * The PRs among `refs` that ONE deploy contains — the fold's own `deployed`
 * (`foldPullRequestState`: the PR merged, and the deploy is a build of its
 * repo made at or after the merge, or names the merge commit), read over the
 * PRs' recorded facts and this deploy alone. One derivation: never a second
 * containment check. Used to name, on a `dev.deployed` fact, the sessions
 * whose PR the build carries (`pr-session-resolver.ts` `sessionsInDeploy`).
 * A failed read THROWS.
 */
export async function pullRequestsInDeploy(
  refs: readonly PullRequestRef[],
  deploy: DevLoopEventRowLike,
  reader: EventReader,
  database: typeof db = db
): Promise<PullRequestRef[]> {
  const unique = new Map(refs.map((r) => [pullRequestKey(r), r]));
  if (unique.size === 0 || deploy.type !== DEV_LOOP_EVENT_TYPES.deployed) {
    return [];
  }
  const prRows = await readPullRequestFactRows(
    [...unique.values()],
    eventVisibleWhere(reader),
    database
  );
  if (prRows.length === 0) return [];
  const rows = [...prRows, deploy];
  return [...unique.values()].filter(
    (ref) => foldPullRequestState(ref, rows)?.deployed === true
  );
}
