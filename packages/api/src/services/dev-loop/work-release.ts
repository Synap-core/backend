/**
 * readWorkRelease — THE Work › Ship read: "can I release, and what blocks it".
 *
 * Three reads, then the ONE fold (`foldWorkRelease`, `@synap-core/types/
 * work-release`), so tRPC `workRelease.get`, Hub `GET /work-release` and MCP
 * `synap_get_work_release` cannot disagree:
 *
 *  1. SNAPSHOTS — the newest `dev.repo_snapshot` per repo, under the reader's
 *     event floor (`eventVisibleWhere`, as `pr-state.ts`), from the last
 *     {@link SNAPSHOT_LOOKBACK_MS}. The pod reads no GitHub of its own: the
 *     devbox producer posts these. A failed read THROWS: there is nothing to
 *     draw, and a calm empty board would be a lie.
 *  2. SESSIONS — the reader's sessions a PR belongs to (`sessionReadableWhere`,
 *     the one session read rule): those a PR body names (`Pod session:`, the
 *     producer's `podSessionId`) and those that declared a PR as an outcome
 *     (`ref.url`, the PR → session resolver's first join). A failed read is
 *     `null` → `sources.sessions: "unavailable"`, never "no session".
 *  3. HOLDERS — who holds each of those sessions and whether they are working
 *     on it now. THE SIGNAL: the pod's own session activity
 *     (`loadSessionLiveness`: a running turn in its room, events recorded in
 *     it, proposals filed under it, asks handed back, room notes), judged by
 *     THE working-now rule (`isSessionWorkingNow`: a turn in flight or
 *     activity in the last 5 min). Not the agent's key liveness
 *     (`synap_list_agents`): every Claude Code session writes as ONE agent, so
 *     an agent being live says nothing about WHICH session it works on. Not the
 *     session runners (0342): only a client holding a change-feed wait stamps
 *     one, which a Claude Code session working on a PR rarely does. The label
 *     is the session's first agent's name, else its owner's. A failed read is
 *     `null` → `sources.holders: "unavailable"`.
 */

import {
  db,
  and,
  desc,
  drizzleSql,
  eq,
  events,
  focusSessions,
  gte,
  inArray,
  or,
  users,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { parsePullRequestRef, type PullRequestRef } from "@synap-core/types";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  REPO_SNAPSHOT_EVENT_TYPE,
  foldWorkRelease,
  repoSnapshotEventSchema,
  type RepoSnapshotFact,
  type WorkReleaseHolderInput,
  type WorkReleaseRead,
  type WorkReleaseSessionInput,
} from "@synap-core/types/work-release";

import {
  eventVisibleWhere,
  type EventReader,
} from "../../access/event-visibility.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { loadSessionLiveness } from "../runs/session-liveness.js";

const logger = createLogger({ module: "dev-loop/work-release" });

/** A repo with no snapshot this recent has left the board. */
export const SNAPSHOT_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** Liveness sources are read back this far (`lastActiveAt` beyond it is null). */
const LIVENESS_LOOKBACK_MS = 24 * 60 * 60_000;

export interface WorkReleaseReader extends EventReader {
  now?: Date;
}

const repoOf = drizzleSql`lower(${events.data}->>'repo')`;

/** The newest valid snapshot per repo the reader may see. Throws on a failed read. */
export async function readRepoSnapshots(
  reader: EventReader,
  now: Date,
  database: typeof db = db
): Promise<RepoSnapshotFact[]> {
  const rows = await database
    .selectDistinctOn([repoOf], { data: events.data, id: events.id })
    .from(events)
    .where(
      and(
        eq(events.type, REPO_SNAPSHOT_EVENT_TYPE),
        gte(events.timestamp, new Date(now.getTime() - SNAPSHOT_LOOKBACK_MS)),
        eventVisibleWhere(reader)
      )
    )
    .orderBy(repoOf, desc(events.timestamp));
  const out: RepoSnapshotFact[] = [];
  for (const row of rows) {
    const parsed = repoSnapshotEventSchema.safeParse(row.data);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      // The door validated it; a row that no longer parses was recorded under
      // an older contract. Named, never drawn as a half-read repo.
      logger.warn(
        { eventId: row.id, issues: parsed.error.issues.slice(0, 3) },
        "work-release: a recorded dev.repo_snapshot no longer parses — skipped"
      );
    }
  }
  return out;
}

interface SessionRow {
  id: string;
  title: string | null;
  goal: string;
  userId: string;
  agentIds: string[] | null;
  channelId: string | null;
  expectedOutputs: unknown;
  startedAt: Date | null;
}

/** The PRs a session declared as outcomes (`ref.url`). */
function declaredPullRequests(expectedOutputs: unknown): PullRequestRef[] {
  if (!Array.isArray(expectedOutputs)) return [];
  const out: PullRequestRef[] = [];
  for (const slot of expectedOutputs) {
    const url = (slot as { ref?: { url?: unknown } } | null)?.ref?.url;
    if (typeof url !== "string") continue;
    const ref = parsePullRequestRef(url);
    if (ref) out.push(ref);
  }
  return out;
}

/** The sessions the snapshots' PRs may belong to. Throws on a failed read. */
async function readPrSessions(
  reader: EventReader,
  snapshots: readonly RepoSnapshotFact[],
  database: typeof db
): Promise<SessionRow[]> {
  const named = new Set<string>();
  const numbers = new Set<number>();
  for (const s of snapshots) {
    for (const p of [...s.prs, ...s.mergedToday]) {
      numbers.add(p.number);
      if (p.podSessionId) named.add(p.podSessionId.toLowerCase());
    }
  }
  if (numbers.size === 0) return [];
  // A text prefilter, as the resolver's: rows that mention one of these PR
  // numbers at all. The exact match (repo, number, any spelling) is the fold's.
  const mentionsPr = drizzleSql`${focusSessions.expectedOutputs}::text ~ ${`/pull/(${[...numbers].join("|")})([^0-9]|$)`}`;
  return database
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      userId: focusSessions.userId,
      agentIds: focusSessions.agentIds,
      channelId: focusSessions.channelId,
      expectedOutputs: focusSessions.expectedOutputs,
      startedAt: focusSessions.startedAt,
    })
    .from(focusSessions)
    .where(
      and(
        sessionReadableWhere({ userId: reader.userId, roster: reader.roster }),
        named.size > 0
          ? or(inArray(focusSessions.id, [...named]), mentionsPr)
          : mentionsPr
      )
    );
}

/** Who holds each session, and its liveness facts. Throws on a failed read. */
async function readHolders(
  reader: EventReader,
  sessions: readonly SessionRow[],
  now: Date,
  database: typeof db
): Promise<WorkReleaseHolderInput[]> {
  if (sessions.length === 0) return [];
  const live = await loadSessionLiveness(
    { userId: reader.userId, roster: reader.roster },
    sessions,
    { since: new Date(now.getTime() - LIVENESS_LOOKBACK_MS) }
  );
  const holderIdOf = (s: SessionRow) => s.agentIds?.[0] ?? s.userId;
  const ids = [...new Set(sessions.map(holderIdOf))];
  const names = new Map(
    (
      await database
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, ids))
    ).map((u) => [u.id, u.name])
  );
  return sessions.map((s) => {
    const facts = live.get(s.id);
    // `loadSessionLiveness` answers null for every session when its read
    // failed: that is "not measured", never "quiet".
    if (facts == null) throw new Error("session liveness read failed");
    return {
      sessionId: s.id,
      label: names.get(holderIdOf(s))?.trim() || "Unnamed",
      live: facts,
    };
  });
}

export async function readWorkRelease(
  reader: WorkReleaseReader,
  database: typeof db = db
): Promise<WorkReleaseRead> {
  const now = reader.now ?? new Date();
  const snapshots = await readRepoSnapshots(reader, now, database);

  let sessionRows: SessionRow[] | null;
  try {
    sessionRows = await readPrSessions(reader, snapshots, database);
  } catch (err) {
    logger.error({ err }, "work-release: the sessions read failed");
    sessionRows = null;
  }
  const sessions: WorkReleaseSessionInput[] | null =
    sessionRows?.map((s) => ({
      id: s.id,
      title: resolveSessionTitle(s) || null,
      pullRequests: declaredPullRequests(s.expectedOutputs),
    })) ?? null;

  let holders: WorkReleaseHolderInput[] | null = null;
  if (sessionRows) {
    try {
      holders = await readHolders(reader, sessionRows, now, database);
    } catch (err) {
      logger.error({ err }, "work-release: the holders read failed");
    }
  }

  return foldWorkRelease(snapshots, sessions, holders, { now });
}
