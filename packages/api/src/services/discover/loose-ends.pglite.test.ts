/**
 * W-B2 — orient's `startHere.looseEnds`: the CALLING AGENT's own leftovers,
 * each with the call that ends it; and `complete_session`'s `leftOwed`.
 *
 * Real, on PGlite: every section's query (`readLooseEnds`), the person-touch
 * read shared with the own-fresh-work predicate (`personTouchedSubjectIds`),
 * the owed-slot predicate (`owedSlotWhere`, `isOwedSlot`) and the warden's
 * never-fired rule over the `automation_runs` ledger. Nothing is stubbed but
 * the database handle.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
  proposals,
  automations,
  automationRuns,
  events,
} from "@synap/database";
import { readLooseEnds, leftOwedAfterClose } from "./loose-ends.js";

const PERSON = "person-1";
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const NOW = new Date("2026-10-26T12:00:00Z");
const OLD = "2026-10-01T00:00:00Z"; // 25 days before NOW
const RECENT = "2026-10-25T00:00:00Z";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = t.endsWith("[]") && !base.endsWith("[]") ? `${base}[]` : base;
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** An owed ask: handed to the person, not done, not retired. */
const ask = (key: string) => ({
  key,
  label: `Answer ${key}`,
  owner: "human",
  blockedReason: "decision",
  why: "only you can decide",
  owedSince: OLD,
});

async function session(p: {
  agent?: string;
  origin?: string;
  status?: string;
  updatedAt?: string;
  outputs?: unknown[];
  goal?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, origin, agent_ids, expected_outputs, metadata, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, '{}'::jsonb, $8, $8)`,
    [
      id,
      PERSON,
      p.goal ?? "tidy the pipeline",
      p.status ?? "active",
      p.origin ?? "agent",
      `{${p.agent ?? AGENT}}`,
      JSON.stringify(p.outputs ?? []),
      p.updatedAt ?? OLD,
    ]
  );
  return id;
}

async function proposal(agent: string, createdAt: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, target_type, target_id, proposal_type, data, agent_user_id, created_by, created_at, updated_at)
     values ($1, 'pending', 'entity', $2, 'update', '{"summary":"Rename a note"}'::jsonb, $3, $3, $4, $4)`,
    [id, randomUUID(), agent, createdAt]
  );
  return id;
}

async function automation(
  createdBy: string,
  triggerType: string
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, name, created_by, status, trigger_type, run_count, trigger_config, created_at, updated_at)
     values ($1, 'Nightly digest', $2, 'active', $3, 0, '{}'::jsonb, $4, $4)`,
    [id, createdBy, triggerType, OLD]
  );
  return id;
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    automations,
    automationRuns,
    events,
  ])
    await h.client!.exec(ddlFor(t as PgTable));
});

beforeEach(async () => {
  for (const t of [
    "focus_sessions",
    "proposals",
    "automations",
    "automation_runs",
    "events",
  ])
    await q(`delete from ${t}`);
});

const ends = () =>
  readLooseEnds({ userId: PERSON, agentUserId: AGENT, now: NOW });

describe("looseEnds — only the calling agent's own work", () => {
  it("lists the agent's own idle session, never another agent's, the person's, or a fresh one", async () => {
    const mine = await session({ goal: "my idle work" });
    await session({ agent: OTHER_AGENT, goal: "another agent's work" });
    await session({ origin: "human", goal: "handed to me by the person" });
    await session({ updatedAt: RECENT, goal: "fresh" });
    await session({ status: "closed", goal: "ended, owes nothing" });

    const r = await ends();
    expect(r.lens).toBe("yours");
    expect(r.sessions).toMatchObject({ count: 1 });
    const items = (r.sessions as { items: Array<{ id: string }> }).items;
    expect(items.map((s) => s.id)).toEqual([mine]);
  });

  it("each idle session names its closing call: close it / withdraw its asks first / ask the person", async () => {
    const clean = await session({ goal: "clean" });
    const owing = await session({ goal: "owing", outputs: [ask("budget")] });
    const touched = await session({ goal: "touched" });
    await q(
      `insert into events (id, subject_id, type, is_agent, agent_user_id, source, timestamp)
       values ($1, $2, 'focus_session.update.completed', false, null, 'api', now())`,
      [randomUUID(), touched]
    );

    const r = await ends();
    const byId = new Map(
      (
        r.sessions as {
          items: Array<{
            id: string;
            owedByPerson: number;
            personTouched: boolean;
            close: string;
          }>;
        }
      ).items.map((s) => [s.id, s])
    );
    expect(byId.get(clean)).toMatchObject({
      owedByPerson: 0,
      personTouched: false,
    });
    expect(byId.get(clean)!.close).toMatch(
      new RegExp(`^synap_complete_session \\{"sessionId":"${clean}"\\}`)
    );
    expect(byId.get(owing)).toMatchObject({ owedByPerson: 1 });
    expect(byId.get(owing)!.close).toMatch(/retireOutput/);
    expect(byId.get(touched)).toMatchObject({ personTouched: true });
    expect(byId.get(touched)!.close).toMatch(/ask them in its room/);
  });

  it("lists the asks the agent left owed on its ENDED sessions, each with its withdraw call", async () => {
    const ended = await session({
      status: "closed",
      goal: "ended with an ask",
      outputs: [
        ask("pricing"),
        { key: "done-one", label: "x", status: "done" },
      ],
    });
    await session({
      agent: OTHER_AGENT,
      status: "closed",
      outputs: [ask("not-mine")],
    });
    await session({ status: "cancelled", outputs: [ask("retired-by-cancel")] });

    const r = await ends();
    expect(r.asks).toMatchObject({ count: 1, countIsLowerBound: false });
    const [item] = (
      r.asks as {
        items: Array<{ sessionId: string; key: string; close: string }>;
      }
    ).items;
    expect(item).toMatchObject({ sessionId: ended, key: "pricing" });
    expect(item!.close).toContain(
      `{"sessionId":"${ended}","retireOutput":"pricing"}`
    );
  });

  it("lists the agent's own proposals pending over a week, with the reject call", async () => {
    const old = await proposal(AGENT, OLD);
    await proposal(AGENT, RECENT);
    await proposal(OTHER_AGENT, OLD);

    const r = await ends();
    expect(r.proposals).toMatchObject({ count: 1, oldestDays: 25 });
    const [item] = (
      r.proposals as { items: Array<{ id: string; close: string }> }
    ).items;
    expect(item!.id).toBe(old);
    expect(item!.close).toContain(
      `synap_reject_proposal {"proposalId":"${old}"`
    );
  });

  it("lists the automations the agent made that never fired, by the warden's rule (manual excluded)", async () => {
    const dead = await automation(AGENT, "cron");
    await automation(AGENT, "manual");
    await automation(OTHER_AGENT, "cron");
    const fired = await automation(AGENT, "event");
    await q(
      `insert into automation_runs (id, automation_id, status, started_at) values ($1, $2, 'completed', now())`,
      [randomUUID(), fired]
    );

    const r = await ends();
    expect(r.automations).toMatchObject({ count: 1 });
    const [item] = (
      r.automations as { items: Array<{ id: string; close: string }> }
    ).items;
    expect(item!.id).toBe(dead);
    expect(item!.close).toContain('"verbId":"automation.archive"');
  });
});

describe("leftOwed — what a close left with the person", () => {
  const owed = [ask("budget"), { key: "mine", label: "Draft", owner: "agent" }];

  it("a close that leaves asks names each one with its withdraw call", () => {
    expect(
      leftOwedAfterClose({ id: "s1", status: "closed", expectedOutputs: owed })
    ).toEqual({
      count: 1,
      items: [
        {
          key: "budget",
          label: "Answer budget",
          close: expect.stringContaining(
            '{"sessionId":"s1","retireOutput":"budget"}'
          ),
        },
      ],
    });
  });

  it("a cancel retires its asks, and nothing owed is nothing to report", () => {
    expect(
      leftOwedAfterClose({
        id: "s1",
        status: "cancelled",
        expectedOutputs: owed,
      })
    ).toBeUndefined();
    expect(
      leftOwedAfterClose({ id: "s1", status: "closed", expectedOutputs: [] })
    ).toBeUndefined();
  });
});
