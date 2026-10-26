/**
 * PARITY: the needs-you SQL (`needsYouSlotClassSql`, the reapers and counts)
 * answers exactly what THE rule answers — `classifyOwedAsk`
 * (`@synap-core/types/needs-you/rule`, decision E).
 *
 * BEHAVIOURAL, on PGlite: each fixture builds a real session with a real room,
 * turns, proposals and events, runs the rendered SQL against it, and runs the
 * rule over the facts the fixture declares. The fixtures are the inputs where
 * naive spellings DISAGREE — each names what it rules out:
 *   - agent evidence read from `updated_at`, or from a HUMAN post / proposal;
 *   - one evidence source dropped (post, turn, proposal, event);
 *   - the session start not counted (a fresh session read as stopped);
 *   - a closed / failed / cancelled session read as live;
 *   - a cause read by truthiness (`askCause: {}`, an array, an empty asker);
 *   - `owedSince` aged off a non-canonical stamp (a SQL cast would THROW on
 *     `0000-00-00`; the rule keeps it);
 *   - a commitment aged into Review later (stakes, a secret, a gate, a relay).
 *
 * TEST-ONLY relative import of the authored rule, the
 * `owed-slot-predicate.parity.pglite.test.ts` pattern.
 *
 * WHAT THIS PROVES: SAMENESS on these rows, never that the rule is right
 * (`rule.test.ts` pins the rule).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql as drizzleSql, type SQL } from "drizzle-orm";
import {
  needsYouSlotClassSql,
  needsYouWhere,
  sessionStoppedOnItsAsksWhere,
  SLOT_ENDS_WITH_SESSION_SQL,
} from "./needs-you-predicate.js";
import { OPEN_SESSION_STATUSES } from "./owed-slot-predicate.js";
import {
  classifyOwedAsk,
  NEEDS_YOU_OPEN_SESSION_STATUSES,
  type NeedsYouSlotFacts,
} from "../../../types/src/needs-you/rule.js";
import { askEndsWithSession } from "../../../types/src/ask/index.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let client: PGlite;
const dialect = new PgDialect();

async function run(sql: SQL): Promise<Array<Record<string, unknown>>> {
  const q = dialect.sqlToQuery(sql);
  return (
    await client.query<Record<string, unknown>>(q.sql, q.params as unknown[])
  ).rows;
}

/** The session side of a fixture: what lives in the database around it. */
interface SessionFixture {
  status?: string;
  startedAt?: string | null;
  /** `updated_at` — must never count. */
  updatedAt?: string;
  agentPostAt?: string;
  humanPostAt?: string;
  turnAt?: string;
  turnRunning?: boolean;
  agentProposalAt?: string;
  humanProposalAt?: string;
  agentEventAt?: string;
  humanEventAt?: string;
}

/** A turn row's `updated_at`: declared, else an old one for a bare running turn. */
function turnTime(s: SessionFixture): string | undefined {
  return s.turnAt ?? (s.turnRunning ? ago(30 * DAY) : undefined);
}

/** The facts the rule reads, as the fixture DECLARES them. */
function factsOf(s: SessionFixture) {
  const agent = [s.agentPostAt, turnTime(s), s.agentProposalAt, s.agentEventAt]
    .filter((v): v is string => !!v)
    .sort()
    .pop();
  return {
    status: s.status ?? "active",
    turnInFlight: !!s.turnRunning,
    lastAgentActivityAt: agent ?? null,
    startedAt: s.startedAt === undefined ? ago(3 * DAY) : s.startedAt,
  };
}

async function insertSession(
  s: SessionFixture,
  slots: unknown[]
): Promise<string> {
  const id = randomUUID();
  const channel = randomUUID();
  const facts = factsOf(s);
  await client.query(
    `insert into focus_sessions (id, status, expected_outputs, channel_id, started_at, updated_at)
     values ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      id,
      facts.status,
      JSON.stringify(slots),
      channel,
      facts.startedAt,
      s.updatedAt ?? NOW.toISOString(),
    ]
  );
  const msg = (author: string, ts: string) =>
    client.query(
      `insert into messages (id, channel_id, author_type, timestamp) values ($1, $2, $3, $4)`,
      [randomUUID(), channel, author, ts]
    );
  if (s.agentPostAt) await msg("ai_agent", s.agentPostAt);
  if (s.humanPostAt) await msg("user", s.humanPostAt);
  if (s.turnAt || s.turnRunning) {
    await client.query(
      `insert into chat_turns (id, channel_id, status, updated_at) values ($1, $2, $3, $4)`,
      [
        randomUUID(),
        channel,
        s.turnRunning ? "running" : "completed",
        turnTime(s),
      ]
    );
  }
  const proposal = (agent: string | null, ts: string) =>
    client.query(
      `insert into proposals (id, session_id, agent_user_id, created_at, status, proposal_type)
       values ($1, $2, $3, $4, 'approved', 'update')`,
      [randomUUID(), id, agent, ts]
    );
  if (s.agentProposalAt) await proposal("agent-1", s.agentProposalAt);
  if (s.humanProposalAt) await proposal(null, s.humanProposalAt);
  const event = (agent: string | null, ts: string) =>
    client.query(
      `insert into events (id, session_id, agent_user_id, timestamp) values ($1, $2, $3, $4)`,
      [randomUUID(), id, agent, ts]
    );
  if (s.agentEventAt) await event("agent-1", s.agentEventAt);
  if (s.humanEventAt) await event(null, s.humanEventAt);
  return id;
}

async function sqlClass(id: string): Promise<string | null> {
  const rows = await run(drizzleSql`
    select ${needsYouSlotClassSql("fs", NOW)} as c
    from focus_sessions fs, jsonb_array_elements(fs.expected_outputs) as slot
    where fs.id = ${id}::uuid`);
  return (rows[0]?.c as string | null) ?? null;
}

const ASK: NeedsYouSlotFacts = {
  owner: "human",
  owedSince: ago(DAY),
  askedBy: "agent-1",
  ask: { mode: "confirm" },
};

/** Live by default: an agent post an hour ago. */
const LIVE: SessionFixture = { agentPostAt: ago(3_600_000) };

const ROWS: ReadonlyArray<{
  rulesOut: string;
  session: SessionFixture;
  slot: NeedsYouSlotFacts;
}> = [
  { rulesOut: "baseline needs you", session: LIVE, slot: ASK },
  // ── not owed ────────────────────────────────────────────────────────────
  {
    rulesOut: "done read as owed",
    session: LIVE,
    slot: { ...ASK, status: "done" },
  },
  {
    rulesOut: "agent slot read as owed",
    session: LIVE,
    slot: { ...ASK, owner: "agent" },
  },
  {
    rulesOut: "retired read as owed",
    session: LIVE,
    slot: { ...ASK, retiredAt: ago(1) },
  },
  // ── the asker ───────────────────────────────────────────────────────────
  {
    rulesOut: "criterion read as asked",
    session: LIVE,
    slot: { owner: "human", criterionKey: "k" },
  },
  {
    rulesOut: "empty criterion key read as a cause",
    session: LIVE,
    slot: { owner: "human", criterionKey: "" },
  },
  {
    rulesOut: "param read as asked",
    session: LIVE,
    slot: { owner: "human", paramName: "p" },
  },
  {
    rulesOut: "run cause beaten by its askedBy",
    session: LIVE,
    slot: { ...ASK, askCause: { kind: "run" } },
  },
  {
    rulesOut: "system decision read as asked",
    session: LIVE,
    slot: { owner: "human", askCause: { kind: "decision" } },
  },
  {
    rulesOut: "empty asker read as an agent",
    session: LIVE,
    slot: { owner: "human", askCause: { kind: "decision" }, askedBy: "" },
  },
  {
    rulesOut: "agent decision read as system",
    session: LIVE,
    slot: { ...ASK, askCause: { kind: "decision" } },
  },
  {
    rulesOut: "gate read as system",
    session: LIVE,
    slot: { owner: "human", askCause: { kind: "gate" } },
  },
  {
    rulesOut: "external approval read as system",
    session: LIVE,
    slot: { owner: "human", askCause: { kind: "external_approval" } },
  },
  {
    rulesOut: "kindless cause read as a cause",
    session: LIVE,
    slot: { ...ASK, askCause: {} },
  },
  {
    rulesOut: "array cause read as a cause",
    session: LIVE,
    slot: { ...ASK, askCause: ["run"] },
  },
  {
    rulesOut: "numeric kind read as a cause",
    session: LIVE,
    slot: { ...ASK, askCause: { kind: 3 } },
  },
  {
    rulesOut: "unstamped legacy slot dropped",
    session: LIVE,
    slot: { owner: "human" },
  },
  // ── stopped ─────────────────────────────────────────────────────────────
  {
    rulesOut: "updated_at read as agent activity",
    session: { startedAt: ago(20 * DAY), updatedAt: NOW.toISOString() },
    slot: ASK,
  },
  {
    rulesOut: "human post read as agent activity",
    session: { startedAt: ago(20 * DAY), humanPostAt: ago(DAY) },
    slot: ASK,
  },
  {
    rulesOut: "human proposal read as agent activity",
    session: { startedAt: ago(20 * DAY), humanProposalAt: ago(DAY) },
    slot: ASK,
  },
  {
    rulesOut: "human event read as agent activity",
    session: { startedAt: ago(20 * DAY), humanEventAt: ago(DAY) },
    slot: ASK,
  },
  {
    rulesOut: "agent post dropped",
    session: { startedAt: ago(20 * DAY), agentPostAt: ago(DAY) },
    slot: ASK,
  },
  {
    rulesOut: "turn dropped",
    session: { startedAt: ago(20 * DAY), turnAt: ago(DAY) },
    slot: ASK,
  },
  {
    rulesOut: "agent proposal dropped",
    session: { startedAt: ago(20 * DAY), agentProposalAt: ago(DAY) },
    slot: ASK,
  },
  {
    rulesOut: "agent event dropped",
    session: { startedAt: ago(20 * DAY), agentEventAt: ago(DAY) },
    slot: ASK,
  },
  {
    rulesOut: "start not counted",
    session: { startedAt: ago(2 * DAY) },
    slot: ASK,
  },
  {
    rulesOut: "no evidence at all read as live",
    session: { startedAt: null },
    slot: ASK,
  },
  {
    rulesOut: "8-day-old evidence read as live",
    session: { startedAt: ago(20 * DAY), agentPostAt: ago(8 * DAY) },
    slot: ASK,
  },
  ...[
    "closed",
    "failed",
    "cancelled",
    "active",
    "paused",
    "stale",
    "weird",
  ].map((status) => ({
    rulesOut: `status ${status}`,
    session: { ...LIVE, status },
    slot: ASK,
  })),
  {
    rulesOut: "machine beaten by stopped",
    session: { startedAt: ago(20 * DAY) },
    slot: { owner: "human", paramName: "p" },
  },
  // ── working ─────────────────────────────────────────────────────────────
  {
    rulesOut: "running turn ignored",
    session: { ...LIVE, turnRunning: true },
    slot: ASK,
  },
  {
    rulesOut: "a fresh agent post ignored",
    session: { agentPostAt: ago(60_000) },
    slot: ASK,
  },
  {
    rulesOut: "window too wide",
    session: { agentPostAt: ago(6 * 60_000) },
    slot: ASK,
  },
  {
    rulesOut: "start read as working",
    session: { startedAt: ago(60_000) },
    slot: ASK,
  },
  {
    rulesOut: "turn on a closed session read as working",
    session: { ...LIVE, status: "closed", turnRunning: true },
    slot: ASK,
  },
  // ── review later ────────────────────────────────────────────────────────
  {
    rulesOut: "old ask kept in the headline",
    session: LIVE,
    slot: { ...ASK, owedSince: ago(8 * DAY) },
  },
  {
    rulesOut: "6-day ask aged",
    session: LIVE,
    slot: { ...ASK, owedSince: ago(6 * DAY) },
  },
  {
    rulesOut: "stakes commitment aged",
    session: LIVE,
    slot: {
      ...ASK,
      owedSince: ago(30 * DAY),
      ask: { mode: "confirm", stakes: "commitment" },
    },
  },
  {
    rulesOut: "secret provide aged",
    session: LIVE,
    slot: {
      ...ASK,
      owedSince: ago(30 * DAY),
      ask: { mode: "provide", provide: { kind: "secret" } },
    },
  },
  {
    rulesOut: "malformed provide read as commitment",
    session: LIVE,
    slot: {
      ...ASK,
      owedSince: ago(30 * DAY),
      ask: { mode: "provide", provide: "secret" },
    },
  },
  {
    rulesOut: "connection provide read as commitment",
    session: LIVE,
    slot: {
      ...ASK,
      owedSince: ago(30 * DAY),
      ask: { mode: "provide", provide: { kind: "connection" } },
    },
  },
  {
    rulesOut: "gate aged",
    session: LIVE,
    slot: {
      owner: "human",
      owedSince: ago(30 * DAY),
      askCause: { kind: "gate" },
    },
  },
  {
    rulesOut: "relay awaiting the tap aged",
    session: LIVE,
    slot: { ...ASK, owedSince: ago(30 * DAY), pendingRelay: { text: "yes" } },
  },
  {
    rulesOut: "sentinel stamp cast (0000-00-00)",
    session: LIVE,
    slot: { ...ASK, owedSince: "0000-00-00" },
  },
  {
    rulesOut: "date-only stamp aged",
    session: LIVE,
    slot: { ...ASK, owedSince: "2026-01-01" },
  },
  {
    rulesOut: "seconds-only stamp aged",
    session: LIVE,
    slot: { ...ASK, owedSince: "2026-01-01T00:00:00Z" },
  },
  {
    rulesOut: "numeric stamp aged",
    session: LIVE,
    slot: { ...ASK, owedSince: 5 },
  },
];

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    create table focus_sessions (id uuid primary key, status text, expected_outputs jsonb, channel_id uuid, started_at timestamptz, updated_at timestamptz);
    create table messages (id uuid primary key, channel_id uuid, author_type text, timestamp timestamptz);
    create table chat_turns (id uuid primary key, channel_id uuid, status text, updated_at timestamptz);
    create table proposals (id uuid primary key, session_id uuid, agent_user_id text, created_at timestamptz, status text, proposal_type text);
    create table events (id uuid primary key, session_id uuid, agent_user_id text, timestamp timestamptz);
  `);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("needsYouSlotClassSql === classifyOwedAsk", () => {
  it("non-vacuity: the fixtures reach every class and the not-owed answer", () => {
    const seen = new Set(
      ROWS.map((r) => classifyOwedAsk(r.slot, factsOf(r.session), NOW))
    );
    expect([...seen].sort()).toEqual(
      [
        null,
        "from_system",
        "needs_you",
        "review_later",
        "stopped",
        "working",
      ].sort()
    );
  });

  it("the open statuses are one list on both sides", () => {
    expect([...OPEN_SESSION_STATUSES]).toEqual([
      ...NEEDS_YOU_OPEN_SESSION_STATUSES,
    ]);
  });

  it("agrees on every discriminating row", async () => {
    for (const { rulesOut, session, slot } of ROWS) {
      const id = await insertSession(session, [slot]);
      expect({ rulesOut, cls: await sqlClass(id) }).toEqual({
        rulesOut,
        cls: classifyOwedAsk(slot, factsOf(session), NOW),
      });
    }
  });

  it("needsYouWhere holds exactly the sessions with a headline ask", async () => {
    const yes = await insertSession(LIVE, [{ owner: "agent" }, ASK]);
    const no = await insertSession(LIVE, [{ ...ASK, owedSince: ago(9 * DAY) }]);
    const rows = await run(drizzleSql`
      select id from focus_sessions
      where id in (${yes}::uuid, ${no}::uuid) and ${needsYouWhere(NOW)}`);
    expect(rows.map((r) => r.id)).toEqual([yes]);
  });
});

describe("SLOT_ENDS_WITH_SESSION_SQL === askEndsWithSession", () => {
  const SLOTS: Array<Record<string, unknown>> = [
    { label: "a", owner: "human", ask: { mode: "confirm" } },
    { label: "a", owner: "human", ask: { mode: "choose", options: [] } },
    { label: "a", owner: "human", ask: { mode: "act" } },
    { label: "a", owner: "human", ask: { mode: "form" } },
    { label: "a", owner: "human", ask: { mode: "provide" } },
    { label: "a", owner: "human", ask: "confirm" },
    { label: "a", owner: "human", ask: { mode: 1 } },
    { label: "a", owner: "human", ask: null, blockedReason: "decision" },
    { label: "a", owner: "human", blockedReason: "decision" },
    {
      label: "a",
      owner: "human",
      blockedReason: "decision",
      kind: "playbook_param",
    },
    { label: "a", owner: "human", blockedReason: "credential" },
    { label: "a", owner: "agent", blockedReason: "decision" },
    { label: "a", owner: "human" },
  ];

  it("agrees on every slot", async () => {
    for (const slot of SLOTS) {
      const rows = await run(drizzleSql`
        select ${SLOT_ENDS_WITH_SESSION_SQL} as e
        from (select ${JSON.stringify(slot)}::jsonb as slot) t`);
      expect({ slot, ends: rows[0]!.e }).toEqual({
        slot,
        ends: askEndsWithSession(slot as never),
      });
    }
    // Non-vacuity: both answers occur.
    const answers = SLOTS.map((s) => askEndsWithSession(s as never));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });
});

describe("sessionStoppedOnItsAsksWhere — the reaper's arm (decision E1)", () => {
  const quiet: SessionFixture = {
    startedAt: ago(20 * DAY),
    agentPostAt: ago(9 * DAY),
  };
  async function stopped(
    s: SessionFixture,
    slots: unknown[]
  ): Promise<boolean> {
    const id = await insertSession(s, slots);
    const rows = await run(drizzleSql`
      select id from focus_sessions where id = ${id}::uuid and ${sessionStoppedOnItsAsksWhere(NOW)}`);
    return rows.length === 1;
  }

  it("stops a quiet session that only owes its agent's confirm / choose asks", async () => {
    expect(
      await stopped(quiet, [ASK, { owner: "human", blockedReason: "decision" }])
    ).toBe(true);
  });

  it("never one an agent moved in 7 days, or one already reaped", async () => {
    expect(await stopped({ ...quiet, agentPostAt: ago(6 * DAY) }, [ASK])).toBe(
      false
    );
    expect(await stopped({ ...quiet, status: "stale" }, [ASK])).toBe(false);
    expect(await stopped({ ...quiet, status: "closed" }, [ASK])).toBe(false);
  });

  it("never one that owes the person an act, a form, a provide or plain work", async () => {
    for (const mode of ["act", "form", "provide"]) {
      expect(await stopped(quiet, [ASK, { ...ASK, ask: { mode } }])).toBe(
        false
      );
    }
    expect(await stopped(quiet, [ASK, { owner: "human" }])).toBe(false);
  });

  it("never one that owes nothing, or waits on a pending gate", async () => {
    expect(await stopped(quiet, [{ owner: "agent" }])).toBe(false);
    const id = await insertSession(quiet, [ASK]);
    await client.query(
      `insert into proposals (id, session_id, agent_user_id, created_at, status, proposal_type)
       values ($1, $2, null, $3, 'pending', 'dev.deploy_approval')`,
      [randomUUID(), id, ago(10 * DAY)]
    );
    const rows = await run(drizzleSql`
      select id from focus_sessions where id = ${id}::uuid and ${sessionStoppedOnItsAsksWhere(NOW)}`);
    expect(rows).toEqual([]);
  });
});
