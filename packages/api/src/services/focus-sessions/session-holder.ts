/**
 * WHO HAS IT — the ONE read that says who holds a session (and a playbook run,
 * through its session: `playbook_runs.session_id`), so no app derives it
 * (plan v2 ba56aa13 §0 sentence 4; Content Studio's `holderOf` guessed it
 * from its room read).
 *
 * No new state set. The holder's one word is a WAIT KIND (`WAIT_KINDS`), and
 * its `kind` is that word's ball (`agent` → agent, `me` → person). Each source
 * keeps its own word in `source`, and maps onto the wait kind once, here:
 *
 *   session status done / lost (closed, failed, cancelled) → nobody (ended)
 *   external agent (`EXTERNAL_AGENT_STATUSES`, its newest run)
 *     running → agent_work · pending_start → approval · needs_input → answer
 *   a LIVE runner of an agent (the one runner order, `RUNNER_STATE_WAIT_KIND`
 *     in @synap-core/types/units, the most urgent first)
 *     needs_permission → approval · needs_answer → answer
 *     busy → agent_work · idle → agent_stopped
 *     no word (its client names none) → the live rule below
 *     (an ENDED runner is not live: the roster's live rule decides, so with
 *     a roster it reads agent_stopped, never "nobody")
 *   the session's last-added roster agent, by the live rule
 *     (`isSessionWorkingNow` on the agent's own clock, `lastAgentWorkAt`)
 *     working → agent_work · not working → agent_stopped
 *   not at work, and the lead wait (`leadWaitKind` over `readWaitingOn`) is
 *     the person's (ball `me`): that wait kind → person (handed back)
 *   no agent anywhere, nothing on the person → nobody (no_agent)
 *
 * A held run that nothing serves (a pull agent on a computer whose runner
 * stamp is stale, `nobodyRunsOf`) reads `agent_stopped` with
 * `agent.nobodyRuns: true`. Plan v2 S2's own wait kind for it ("nobody is
 * running <agent>", ball: the person) belongs to the status-first lanes; when
 * it lands, that one row of the mapping moves to it.
 *
 * EMPTY vs FAILED: any read the holder needs that failed makes the whole
 * answer `unavailable`, never "nobody".
 */

import { db, inArray, users } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  agentDisplayName,
  MACHINE_AGENT_TYPE,
  type AgentReach,
  type ExternalAgentStatus,
} from "@synap-core/types/agents";
import { sessionStatusCategory } from "@synap-core/types/focus-sessions";
import {
  isSessionWorkingNow,
  type SessionActivityLive,
} from "@synap-core/types/run-activity";
import {
  leadWaitKind,
  runnerStateRank,
  runnerStateWaitKind,
  WAIT_KIND_BALL,
  type WaitKind,
  type WaitingOnMark,
} from "@synap-core/types/units";
import type { ExpectedOutput } from "@synap/playbooks";
import { actorComputer, nameWithComputer } from "../actor-computer.js";
import { loadAgentPresence, nobodyRunsOf } from "../agent-presence.js";
import { loadAgentDispatchSummaries } from "../agent-dispatch/agent-binding.js";
import {
  readSessionExternalAgentsFor,
  type SessionExternalAgent,
} from "../agent-dispatch/session-external-agent.js";
import { loadMachineNames } from "../machine-roster.js";
import { loadSessionLiveness } from "../runs/session-liveness.js";
import {
  readWaitingOnFor,
  sessionWaitingOnQuestion,
} from "../status/status-facts.js";
import { isOwedSlot } from "./owed-outputs.js";
import {
  loadSessionRunnersFor,
  type SessionRunner,
} from "./session-runners.js";

const logger = createLogger({ module: "session-holder" });

/** The agent on a session, named in the one attribution order (S10). */
export interface HolderAgent {
  agentUserId: string;
  name: string | null;
  /** "Claude Code on devbox" (its host) or "Claude Code, last seen on MacBook" (a key label). */
  displayName: string;
  agentType: string | null;
  /** Its computer: the host machine, else the label of the key it was last seen on. */
  computer: {
    /** The machine's own principal; `null` when it is only a key label. */
    agentUserId: string | null;
    name: string;
    source: "host" | "key";
  } | null;
  reach: AgentReach;
  /** The newest call a process RUNNING this agent made; `null` = never measured. */
  servedAt: string | null;
  /** `nobodyRunsOf`: true = nothing runs it now; null = not measured / not applicable. */
  nobodyRuns: boolean | null;
}

/** Where the holder's word came from, in that source's own words. */
export type HolderSource =
  | { from: "session"; status: string }
  | { from: "external_agent"; status: ExternalAgentStatus | "unknown" }
  | { from: "runner"; state: SessionRunner["state"] }
  | { from: "live"; working: boolean }
  | { from: "waiting_on" }
  | { from: "roster" };

export interface SessionHolder {
  /** Whose move: the ball of `waitKind` (`agent` → agent, `me` → person); nobody when none. */
  kind: "agent" | "person" | "nobody";
  /** THE one word (`WAIT_KINDS`); `null` for nobody. */
  waitKind: WaitKind | null;
  /** When it entered this state (ISO); `null` = not measured. */
  since: string | null;
  /** The agent on it — for a person, the one that handed it back; `null` = none. */
  agent: HolderAgent | null;
  source: HolderSource;
  /** Nobody only: the session ended, or no agent is on it. */
  reason?: "ended" | "no_agent";
}

export type SessionHolderSection =
  | { status: "ok"; holder: SessionHolder }
  | { status: "unavailable"; reason: string };

/** The facts the holder is derived from — each read by its own door. */
export interface SessionHolderFacts {
  session: {
    status: string;
    agentIds: readonly string[] | null;
    expectedOutputs: unknown;
    startedAt?: Date | string | null;
    closedAt?: Date | string | null;
    updatedAt?: Date | string | null;
  };
  externalAgent: SessionExternalAgent | null;
  runners: ReadonlyArray<
    Pick<
      SessionRunner,
      "agentUserId" | "live" | "state" | "stateSince" | "lastSeenAt"
    >
  >;
  live: SessionActivityLive;
  waitingOn: readonly WaitingOnMark[];
  now: number;
}

/** The holder before its agent is named: the agent is an id. */
export type SessionHolderVerdict = Omit<SessionHolder, "agent"> & {
  agentUserId: string | null;
};

const iso = (v: Date | string | null | undefined): string | null => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

const EXTERNAL_WORD: Partial<Record<ExternalAgentStatus, WaitKind>> = {
  running: "agent_work",
  pending_start: "approval",
  needs_input: "answer",
};

/** The earliest hand-back among the person's owed slots on the row. */
function owedSince(expectedOutputs: unknown): string | null {
  const slots = Array.isArray(expectedOutputs)
    ? (expectedOutputs as ExpectedOutput[])
    : [];
  let first: string | null = null;
  for (const slot of slots) {
    if (!slot || typeof slot !== "object" || !isOwedSlot(slot)) continue;
    const at = iso((slot as { owedSince?: string }).owedSince ?? null);
    if (at && (!first || at < first)) first = at;
  }
  return first;
}

/**
 * THE derivation. Pure: every fact is read by its own door, the clock is a
 * parameter. The agent comes back as an id; {@link loadHolderAgents} names it.
 */
export function deriveSessionHolder(
  f: SessionHolderFacts
): SessionHolderVerdict {
  const category = sessionStatusCategory(f.session.status);
  if (category === "done" || category === "lost") {
    return {
      kind: "nobody",
      waitKind: null,
      since: iso(f.session.closedAt ?? f.session.updatedAt ?? null),
      agentUserId: null,
      source: { from: "session", status: f.session.status },
      reason: "ended",
    };
  }

  // The agent's own clock: a person's act or the agent's question is not work.
  const working = isSessionWorkingNow(
    {
      turnInFlight: f.live.turnInFlight,
      lastAt: f.live.lastAgentWorkAt ?? null,
    },
    f.now
  );
  const workSince = f.live.turnInFlight
    ? iso(f.live.since ?? f.live.lastAgentWorkAt ?? null)
    : iso(f.live.lastAgentWorkAt ?? null);
  const byLiveRule = {
    waitKind: (working ? "agent_work" : "agent_stopped") as WaitKind,
    since: workSince,
  };

  let candidate: {
    agentUserId: string;
    waitKind: WaitKind;
    since: string | null;
    source: HolderSource;
  } | null = null;

  const roster = (f.session.agentIds ?? []).filter(Boolean);
  const ext = f.externalAgent;
  const extWord =
    ext && ext.status !== "unknown" ? EXTERNAL_WORD[ext.status] : undefined;
  if (ext && extWord) {
    candidate = {
      agentUserId: ext.agentUserId,
      waitKind: extWord,
      since: iso(ext.status === "running" ? ext.lastNewsAt : ext.startedAt),
      source: { from: "external_agent", status: ext.status },
    };
  } else {
    // A live runner of an AGENT (a person's own key holds no run for anyone
    // else), the roster's first; the most urgent word wins.
    const live = f.runners.filter(
      (r): r is typeof r & { agentUserId: string } => r.live && !!r.agentUserId
    );
    const onRoster = live.filter((r) => roster.includes(r.agentUserId));
    const pool = onRoster.length > 0 ? onRoster : live;
    // The one order (`RUNNER_STATE_ORDER`), the fold's: most urgent first.
    const runner = [...pool].sort(
      (a, b) => runnerStateRank(a.state) - runnerStateRank(b.state)
    )[0];
    if (runner) {
      const said = runnerStateWaitKind(runner.state);
      candidate = said
        ? {
            agentUserId: runner.agentUserId,
            waitKind: said,
            since: iso(runner.stateSince ?? runner.lastSeenAt),
            source: { from: "runner", state: runner.state },
          }
        : {
            agentUserId: runner.agentUserId,
            ...byLiveRule,
            source: { from: "live", working },
          };
    } else if (roster.length > 0) {
      // The last hand-off is the last id on the roster (the starter is first).
      candidate = {
        agentUserId: roster[roster.length - 1]!,
        ...byLiveRule,
        source: { from: "live", working },
      };
    }
  }

  // The agent's own word puts the ball with the person (a permission dialog,
  // a start to approve, a question): that word, the agent named.
  if (candidate && WAIT_KIND_BALL[candidate.waitKind] === "me") {
    return { kind: "person", ...candidate };
  }
  if (candidate?.waitKind === "agent_work") {
    return { kind: "agent", ...candidate };
  }
  // Not at work: handed back when the lead wait is the person's.
  const lead = leadWaitKind(f.waitingOn);
  if (lead && WAIT_KIND_BALL[lead] === "me") {
    return {
      kind: "person",
      waitKind: lead,
      since: lead === "approval" ? null : owedSince(f.session.expectedOutputs),
      agentUserId: candidate?.agentUserId ?? null,
      source: { from: "waiting_on" },
    };
  }
  if (candidate) return { kind: "agent", ...candidate };
  return {
    kind: "nobody",
    waitKind: null,
    since: null,
    agentUserId: null,
    source: { from: "roster" },
    reason: "no_agent",
  };
}

/**
 * Name agents for the holder: the S10 attribution order (host machine, else
 * the last-seen key's label), reach, and whether anything runs them
 * (`nobodyRunsOf`, the hand-off roster's rule). The ids come from a session
 * the caller already read through its floor. THROWS on a failed read.
 */
export async function loadHolderAgents(
  agentUserIds: readonly string[],
  now: Date = new Date()
): Promise<Map<string, HolderAgent>> {
  const ids = [...new Set(agentUserIds)].filter(Boolean);
  const out = new Map<string, HolderAgent>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      agentType: users.agentType,
      hostUserId: users.hostUserId,
    })
    .from(users)
    .where(inArray(users.id, ids));
  const agents = rows.filter((r) => r.agentType !== MACHINE_AGENT_TYPE);
  const agentIds = agents.map((r) => r.id);
  const [machines, presence, dispatch] = await Promise.all([
    loadMachineNames(
      agents.map((r) => r.hostUserId).filter((h): h is string => !!h)
    ),
    loadAgentPresence(agentIds, now),
    loadAgentDispatchSummaries(agentIds),
  ]);
  for (const r of agents) {
    const seen = presence.get(r.id);
    const named = actorComputer({
      hostName: r.hostUserId ? machines.get(r.hostUserId)?.name : null,
      keyLabel: seen?.hostLabel,
    });
    const reach = dispatch.get(r.id)?.reach ?? "pull";
    const servedAt = seen?.servedAt ?? null;
    out.set(r.id, {
      agentUserId: r.id,
      name: r.name,
      displayName: named
        ? nameWithComputer(r.name, named)
        : agentDisplayName({ name: r.name }),
      agentType: r.agentType,
      computer: named
        ? {
            agentUserId: named.source === "host" ? r.hostUserId : null,
            name: named.name,
            source: named.source,
          }
        : null,
      reach,
      servedAt,
      nobodyRuns: nobodyRunsOf({
        reach,
        onComputer: !!named,
        servedAt,
        now,
      }),
    });
  }
  return out;
}

/** The verdict with its agent named. An id that names no agent reads as none. */
export function nameHolder(
  verdict: SessionHolderVerdict,
  agents: ReadonlyMap<string, HolderAgent>
): SessionHolder {
  const { agentUserId, ...rest } = verdict;
  return {
    ...rest,
    agent: agentUserId ? (agents.get(agentUserId) ?? null) : null,
  };
}

/** The session-row fields the holder reads. */
export interface HolderSessionRow {
  id: string;
  userId: string;
  status: string;
  channelId: string | null;
  agentIds: string[] | null;
  expectedOutputs: unknown;
  startedAt?: Date | string | null;
  closedAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

/**
 * The holder of one session, read on its own — for a door that does not build
 * the continuation packet (Hub GET /focus-sessions/:id when the packet is
 * withheld from an app key). One row of {@link readSessionHolders}, the read
 * the list and graph rows run too. The packet derives the same answer from
 * the sections it already read, through the same loaders. The row must
 * already be read through the caller's floor. A failed read is
 * `unavailable`, never "nobody".
 */
export async function readSessionHolder(
  row: HolderSessionRow,
  ctx: { userId: string; roster?: boolean; database?: typeof db; now?: Date }
): Promise<SessionHolderSection> {
  return (
    (await readSessionHolders([row], ctx)).get(row.id) ?? holderUnavailable()
  );
}

/**
 * THE holder of MANY sessions, in a bounded number of reads whatever their
 * number: the runners (one query), the external agents (one query, plus a
 * few for the sessions that have one), the liveness (taken from `live` when
 * the caller already attached it, else one batch), the waiting-on (one
 * collector call for every session) and the agents' names (four queries). An
 * ended session needs none of them.
 *
 * EMPTY vs FAILED, per row: a read that failed makes `unavailable` every row
 * that needed it (a row whose liveness is `null`, a row whose agent could not
 * be named), never "nobody". Every row is in the map. Rows are read through
 * the caller's floor.
 */
export async function readSessionHolders(
  rows: readonly HolderSessionRow[],
  ctx: {
    userId: string;
    roster?: boolean;
    /** A bound key's workspace: the waiting-on's PR facts are read under it. */
    lens?: string;
    database?: typeof db;
    now?: Date;
    /**
     * Liveness already read for these rows (`attachSessionLiveness`, same
     * reader): not read again. A row absent from it is read; a `null` is a
     * failed read and stays one.
     */
    live?: ReadonlyMap<string, SessionActivityLive | null>;
  }
): Promise<Map<string, SessionHolderSection>> {
  const now = ctx.now ?? new Date();
  const database = ctx.database ?? db;
  const out = new Map<string, SessionHolderSection>();
  const sessionOf = (row: HolderSessionRow) => ({
    status: row.status,
    agentIds: row.agentIds,
    expectedOutputs: row.expectedOutputs,
    startedAt: row.startedAt,
    closedAt: row.closedAt,
    updatedAt: row.updatedAt,
  });
  const open: HolderSessionRow[] = [];
  for (const row of rows) {
    const ended = ["done", "lost"].includes(
      sessionStatusCategory(row.status) ?? ""
    );
    if (!ended) {
      open.push(row);
      continue;
    }
    const verdict = deriveSessionHolder({
      session: sessionOf(row),
      externalAgent: null,
      runners: [],
      live: { turnInFlight: false, since: null, lastAt: null },
      waitingOn: [],
      now: now.getTime(),
    });
    out.set(row.id, { status: "ok", holder: nameHolder(verdict, new Map()) });
  }
  if (open.length === 0) return out;

  const ids = open.map((r) => r.id);
  const toRead = open.filter((r) => !ctx.live?.has(r.id));
  let facts: {
    externalAgents: Map<string, SessionExternalAgent | null>;
    runners: Map<string, SessionRunner[]>;
    liveness: Map<string, SessionActivityLive | null>;
    waitingOn: Map<string, WaitingOnMark[]>;
  };
  try {
    const [externalAgents, runners, liveness, waitingOn] = await Promise.all([
      readSessionExternalAgentsFor(ids, database),
      loadSessionRunnersFor(ids, { database, limit: 100, now }),
      toRead.length > 0
        ? loadSessionLiveness(
            { userId: ctx.userId, roster: !!ctx.roster },
            toRead
          )
        : Promise.resolve(new Map<string, SessionActivityLive | null>()),
      readWaitingOnFor(
        {
          userId: ctx.userId,
          roster: ctx.roster,
          ...(ctx.lens !== undefined ? { lens: ctx.lens } : {}),
        },
        new Map(ids.map((id) => [id, sessionWaitingOnQuestion(id)]))
      ),
    ]);
    facts = { externalAgents, runners, liveness, waitingOn };
  } catch (err) {
    logger.warn({ err, sessions: ids.length }, "session holder read failed");
    for (const id of ids) out.set(id, holderUnavailable());
    return out;
  }

  const verdicts = new Map<string, SessionHolderVerdict>();
  for (const row of open) {
    const live = ctx.live?.has(row.id)
      ? ctx.live.get(row.id)
      : facts.liveness.get(row.id);
    if (!live) {
      out.set(row.id, holderUnavailable());
      continue;
    }
    verdicts.set(
      row.id,
      deriveSessionHolder({
        session: sessionOf(row),
        externalAgent: facts.externalAgents.get(row.id) ?? null,
        runners: facts.runners.get(row.id) ?? [],
        live,
        waitingOn: facts.waitingOn.get(row.id) ?? [],
        now: now.getTime(),
      })
    );
  }

  const agentIds = [...verdicts.values()].flatMap((v) =>
    v.agentUserId ? [v.agentUserId] : []
  );
  let agents: Map<string, HolderAgent> | null = new Map();
  if (agentIds.length > 0) {
    try {
      agents = await loadHolderAgents(agentIds, now);
    } catch (err) {
      logger.warn(
        { err, agents: agentIds.length },
        "session holder agents read failed"
      );
      agents = null;
    }
  }
  for (const [id, verdict] of verdicts) {
    out.set(
      id,
      verdict.agentUserId && agents === null
        ? holderUnavailable()
        : { status: "ok", holder: nameHolder(verdict, agents ?? new Map()) }
    );
  }
  return out;
}

/**
 * THE holder on every list and graph row (sessions cockpit C5): the
 * `attachNextMove` / `attachSessionLiveness` family's member for "who has
 * it", run AFTER liveness so its `live` is reused, never read twice. Same
 * floor as the rows' door. Each row gets `holder`, a section: `unavailable`
 * when a fact it needed could not be read, never "nobody".
 */
export async function attachSessionHolder<
  R extends HolderSessionRow & { live?: SessionActivityLive | null },
>(
  rows: readonly R[],
  ctx: {
    userId: string;
    roster?: boolean;
    /** A bound key's workspace (the graph door's `boundWorkspaceId`). */
    lens?: string;
    database?: typeof db;
    now?: Date;
  }
): Promise<Array<R & { holder: SessionHolderSection }>> {
  const live = new Map<string, SessionActivityLive | null>();
  for (const r of rows) {
    if (r.live !== undefined) live.set(r.id, r.live);
  }
  const holders = await readSessionHolders(rows, { ...ctx, live });
  return rows.map((r) => ({
    ...r,
    holder: holders.get(r.id) ?? holderUnavailable(),
  }));
}

export const HOLDER_UNAVAILABLE_REASON =
  "Who has this session could not be read.";

export function holderUnavailable(): SessionHolderSection {
  return { status: "unavailable", reason: HOLDER_UNAVAILABLE_REASON };
}
