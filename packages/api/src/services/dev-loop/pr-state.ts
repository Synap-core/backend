/**
 * readPullRequestStates — THE read of what the pod knows about pull requests:
 * the dev-loop facts it recorded (`dev.pr_*`, `ci.finished`, `dev.deployed`),
 * under the reader's event floor (`eventVisibleWhere`), folded by the ONE rule
 * (`foldPullRequestState`, `@synap-core/types`).
 *
 * A PR with no recorded fact is ABSENT from the map (an older pod, a repo with
 * no producer): the caller draws nothing, never a guessed "Open". A failed
 * read THROWS, so the caller can say `unavailable` instead of absent.
 *
 * Two queries, both bounded by the PRs asked about: the PR facts first, then
 * the CI runs and deploys that can only be matched once the PR's head and
 * merge shas are known. A deploy is read when it names a merge sha, or, once
 * some PR merged, when it is a build of one of the PRs' repos that says when
 * its commit was made (`builtAt`): the fold decides which merges it contains.
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
import { and, inArray, or, sql, type SQL } from "drizzle-orm";

import {
  eventVisibleWhere,
  type EventReader,
} from "../../access/event-visibility.js";

export { pullRequestKey };

const PR_TYPES = [
  DEV_LOOP_EVENT_TYPES.prOpened,
  DEV_LOOP_EVENT_TYPES.prMerged,
  DEV_LOOP_EVENT_TYPES.prClosed,
];

/** Shas are matched on their first 7 characters in SQL, exactly in the fold. */
const SHORT = 7;

function shortSha(sha: unknown): string | null {
  return typeof sha === "string" && sha.length >= SHORT
    ? sha.slice(0, SHORT).toLowerCase()
    : null;
}

const repoOf = sql<string>`lower(${events.data}->>'repo')`;
const shaOf = sql<string>`lower(left(${events.data}->>'sha', ${SHORT}))`;

export async function readPullRequestStates(
  refs: readonly PullRequestRef[],
  reader: EventReader,
  database: typeof db = db
): Promise<Map<string, PullRequestStateFacts>> {
  const out = new Map<string, PullRequestStateFacts>();
  const unique = new Map(refs.map((r) => [pullRequestKey(r), r]));
  if (unique.size === 0) return out;
  const visible = eventVisibleWhere(reader);
  const select = {
    type: events.type,
    timestamp: events.timestamp,
    data: events.data,
  };

  const prRows: DevLoopEventRowLike[] = await database
    .select(select)
    .from(events)
    .where(
      and(
        inArray(events.type, PR_TYPES),
        or(
          ...[...unique.values()].map(
            (r) =>
              sql`(${repoOf} = ${r.repo.toLowerCase()} and ${events.data}->>'number' = ${String(r.number)})`
          )
        ),
        visible
      )
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
      sql`${events.type} = ${DEV_LOOP_EVENT_TYPES.ciFinished}`,
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
  const laterRows: DevLoopEventRowLike[] = await database
    .select(select)
    .from(events)
    .where(and(or(...followUps), visible));

  const rows = [...prRows, ...laterRows];
  for (const [key, ref] of unique) {
    const facts = foldPullRequestState(ref, rows);
    if (facts) out.set(key, facts);
  }
  return out;
}
