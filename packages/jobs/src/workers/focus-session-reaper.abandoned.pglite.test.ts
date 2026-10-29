/**
 * W-B4 — the reaper stales an AGENT's abandoned session, on PGlite.
 *
 * Real: `staleAbandonedAgentSessions` → `AGENT_SESSION_MAY_BE_ABANDONED` SQL →
 * `personTouchedSubjectIds` (@synap/database, the own-fresh-work person-touch
 * test) → `setSessionStatus` (the one session status write). A session
 * that waits on the person, opened by an agent, silent 14 days, that no
 * person ever wrote on, becomes `stale` and owes its transition; its asks
 * stay owed. A person-touched one, a person's own, a fresh one, or one that owes
 * nothing (the main sweep's) is left alone.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  messages,
  events,
  proposals,
  chatTurns,
  lifecycleTransitionOutbox,
} from "@synap/database/schema";
import {
  AGENT_SESSION_ABANDONED_DAYS,
  staleAbandonedAgentSessions,
} from "./focus-session-reaper.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OWED = [{ label: "Pick a logo", owner: "human", status: "pending" }];

async function session(opts: {
  origin?: string;
  idleDays: number;
  owes?: boolean;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, origin, expected_outputs, metadata, started_at, updated_at)
     values ($1, 'u1', 'g', $2, $3, $4::jsonb, '{}'::jsonb, now(), now() - ($5::int * interval '1 day'))`,
    [
      id,
      opts.status ?? "active",
      opts.origin ?? "agent",
      JSON.stringify(opts.owes === false ? [] : OWED),
      opts.idleDays,
    ]
  );
  return id;
}

/** A completed write on the session, by a person (no agent) or an agent. */
async function wrote(sessionId: string, by: "person" | "agent") {
  await q(
    `insert into events (id, subject_id, subject_type, type, user_id, is_agent, agent_user_id, source, data, timestamp)
     values ($1, $2, 'focus_session', 'focus_session.update.completed', 'u1', $3, $4, 'api', '{}'::jsonb, now())`,
    [
      randomUUID(),
      sessionId,
      by === "agent",
      by === "agent" ? randomUUID() : null,
    ]
  );
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.status;

const OLD = AGENT_SESSION_ABANDONED_DAYS + 1;

beforeAll(async () => {
  // Every table the waits-on-the-person predicate reads (needs-you-predicate:
  // the session's room, turns, proposals and events), and the outbox the one
  // session status write owes each transition to.
  for (const t of [
    focusSessions,
    messages,
    events,
    proposals,
    chatTurns,
    lifecycleTransitionOutbox,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from events; delete from lifecycle_transition_outbox;"
  );
});

describe("staleAbandonedAgentSessions", () => {
  it("stales an agent's session silent 14 days that only waits on the person; its ask stays owed", async () => {
    const left = await session({ idleDays: OLD });
    await wrote(left, "agent");
    expect(await staleAbandonedAgentSessions()).toBe(1);
    expect(await statusOf(left)).toBe("stale");
    const [row] = (
      await q<{ expected_outputs: unknown }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [left]
      )
    ).rows;
    expect(row!.expected_outputs).toEqual(OWED);
    // The move went through the one session status write: it owes its transition.
    const owed = await q<{ to: string; subject: string }>(
      `select transition->>'to' as to, transition->>'subjectId' as subject from lifecycle_transition_outbox`
    );
    expect(owed.rows).toEqual([{ to: "stale", subject: left }]);
  });

  it("never stales a session a person wrote on", async () => {
    const shared = await session({ idleDays: OLD });
    await wrote(shared, "agent");
    await wrote(shared, "person");
    expect(await staleAbandonedAgentSessions()).toBe(0);
    expect(await statusOf(shared)).toBe("active");
  });

  it("never stales a person's own session, a recent one, or one already ended", async () => {
    const mine = await session({ origin: "user", idleDays: OLD });
    const recent = await session({
      idleDays: AGENT_SESSION_ABANDONED_DAYS - 1,
    });
    const closed = await session({ idleDays: OLD, status: "closed" });
    expect(await staleAbandonedAgentSessions()).toBe(0);
    expect(await statusOf(mine)).toBe("active");
    expect(await statusOf(recent)).toBe("active");
    expect(await statusOf(closed)).toBe("closed");
  });

  it("leaves a session that owes nothing to the main 24 h sweep", async () => {
    await session({ idleDays: OLD, owes: false });
    expect(await staleAbandonedAgentSessions()).toBe(0);
  });
});
