/**
 * THE TIMEOUT ARM (P5, lead default C) — on PGlite: the REAL sweep
 * (`sweepDecisionTimeouts`), the REAL provenance stamp
 * (`stampDefaultOptionAuthor`, read off the write's `events` row) and the
 * pure plan. Captured, and why: the decision door (`updateDecisionEntity`:
 * its own suites cover it; here it records the call and lands the props it
 * would land) and the notification write (its own suite covers the door).
 *
 * Each case names the WRONG rule it rules out.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  created: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: string; properties: Record<string, unknown> }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: async (input: Record<string, unknown>) => {
      h.created.push(input);
      return "n-1";
    },
  },
}));

vi.mock("../decision-entity-door.js", () => ({
  updateDecisionEntity: async (
    _scope: unknown,
    id: string,
    properties: Record<string, unknown>
  ) => {
    h.updates.push({ id, properties });
    await h.client!.query(
      `update entities set status = $2, status_category = 'done', properties = properties || $3::jsonb where id = $1`,
      [id, properties.decisionStatus, JSON.stringify(properties)]
    );
  },
}));

import {
  allSchemaTables,
  pgliteTableDdl,
} from "../../../__tests__/pglite-ddl.js";
import {
  DECIDED_BY_TIMEOUT_NOTIFICATION_TYPE,
  DECISION_OVERDUE_NOTIFICATION_TYPE,
  authorKindOfEvent,
  planDecisionTimeout,
  stampDefaultOptionAuthor,
  sweepDecisionTimeouts,
} from "../decision-timeout.js";

const OWNER = "user-owner";
const AGENT = "agent-1";
const NOW = new Date("2026-11-23T12:00:00.000Z");
const PAST = "2026-11-23T09:00:00.000Z";
const FUTURE = "2026-11-24T09:00:00.000Z";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const OPTIONS = [
  { label: "Raise", value: "raise" },
  { label: "Bootstrap", value: "bootstrap" },
];

async function decision(props: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, status, status_category, properties, system_data)
     values ($1, $2, null, 'decision', 'Fund the company', 'proposed', 'open', $3::jsonb, '{}'::jsonb)`,
    [
      id,
      OWNER,
      JSON.stringify({
        decisionStatus: "proposed",
        decisionOptions: OPTIONS,
        ...props,
      }),
    ]
  );
  return id;
}

/** The write's audit row, as `recordDomainMutation` lands it. */
async function writeEvent(decisionId: string, agentUserId: string | null) {
  const id = randomUUID();
  await q(
    `insert into events (id, type, subject_id, subject_type, data, user_id, agent_user_id, is_agent)
     values ($1, 'entities.update.completed', $2, 'entity', '{}'::jsonb, $3, $4, $5)`,
    [id, decisionId, OWNER, agentUserId, agentUserId ? true : null]
  );
  return id;
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from entities where id = $1`, [
      id,
    ])
  ).rows[0]!.status;

const systemOf = async (id: string) =>
  (
    await q<{ system_data: Record<string, unknown> }>(
      `select system_data from entities where id = $1`,
      [id]
    )
  ).rows[0]!.system_data;

beforeAll(async () => {
  for (const t of allSchemaTables()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
});

beforeEach(async () => {
  h.created.length = 0;
  h.updates.length = 0;
  await q(`delete from entities`);
});

describe("planDecisionTimeout — pure", () => {
  const base = {
    status: "proposed",
    answerBy: PAST,
    defaultOption: "raise",
    defaultOptionBy: { option: "raise", kind: "person" },
    optionKeys: ["raise", "bootstrap"],
    now: NOW,
  };
  it("applies only the person's default, past the date", () => {
    expect(planDecisionTimeout(base)).toEqual({
      action: "apply",
      option: "raise",
    });
  });
  it("an agent's default only reminds (rules out 'an agent decides for the person')", () => {
    expect(
      planDecisionTimeout({
        ...base,
        defaultOptionBy: { option: "raise", kind: "agent" },
      })
    ).toEqual({ action: "remind", reason: "agent_default" });
  });
  it("a stamp for ANOTHER value, or none, reminds (rules out 'a stale stamp vouches for a new default')", () => {
    expect(
      planDecisionTimeout({
        ...base,
        defaultOptionBy: { option: "bootstrap", kind: "person" },
      }).action
    ).toBe("remind");
    expect(
      planDecisionTimeout({ ...base, defaultOptionBy: undefined }).action
    ).toBe("remind");
  });
  it("no default, or one the decision does not list, reminds", () => {
    expect(planDecisionTimeout({ ...base, defaultOption: undefined })).toEqual({
      action: "remind",
      reason: "no_default",
    });
    expect(
      planDecisionTimeout({
        ...base,
        defaultOption: "sell",
        defaultOptionBy: { option: "sell", kind: "person" },
      })
    ).toEqual({ action: "remind", reason: "unknown_option" });
  });
  it("CONTROL: not yet due, unparsable, or not proposed waits", () => {
    expect(planDecisionTimeout({ ...base, answerBy: FUTURE }).action).toBe(
      "wait"
    );
    expect(planDecisionTimeout({ ...base, answerBy: "soon" }).action).toBe(
      "wait"
    );
    expect(planDecisionTimeout({ ...base, status: "accepted" }).action).toBe(
      "wait"
    );
  });
  it("an event with an agent identity is an agent's; no event is unknown", () => {
    expect(authorKindOfEvent({ agentUserId: AGENT, isAgent: null })).toBe(
      "agent"
    );
    expect(authorKindOfEvent({ agentUserId: null, isAgent: true })).toBe(
      "agent"
    );
    expect(authorKindOfEvent({ agentUserId: null, isAgent: null })).toBe(
      "person"
    );
    expect(authorKindOfEvent(undefined)).toBe("unknown");
  });
});

describe("stampDefaultOptionAuthor — the pod's fact, off the write's events row", () => {
  it("a person's write stamps person; an agent's stamps agent", async () => {
    const mine = await decision({ defaultOption: "raise" });
    await stampDefaultOptionAuthor(mine, await writeEvent(mine, null));
    expect((await systemOf(mine)).defaultOptionBy).toMatchObject({
      option: "raise",
      kind: "person",
    });

    const theirs = await decision({ defaultOption: "raise" });
    await stampDefaultOptionAuthor(theirs, await writeEvent(theirs, AGENT));
    expect((await systemOf(theirs)).defaultOptionBy).toMatchObject({
      option: "raise",
      kind: "agent",
      userId: AGENT,
    });
  });

  it("no event row stamps unknown; a cleared default drops the stamp", async () => {
    const id = await decision({ defaultOption: "raise" });
    await stampDefaultOptionAuthor(id, null);
    expect((await systemOf(id)).defaultOptionBy).toMatchObject({
      kind: "unknown",
    });
    await q(
      `update entities set properties = properties - 'defaultOption' where id = $1`,
      [id]
    );
    await stampDefaultOptionAuthor(id, null);
    expect((await systemOf(id)).defaultOptionBy).toBeUndefined();
  });
});

describe("sweepDecisionTimeouts — past answerBy", () => {
  it("the PERSON's default applies: accepted with it, recorded, one notice", async () => {
    const id = await decision({ answerBy: PAST, defaultOption: "bootstrap" });
    await stampDefaultOptionAuthor(id, await writeEvent(id, null));

    expect(await sweepDecisionTimeouts(NOW)).toBe(1);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.properties).toMatchObject({
      decisionStatus: "accepted",
      chosenOption: "bootstrap",
    });
    expect(String(h.updates[0]!.properties.rationale)).toContain(
      "Decided by timeout"
    );
    expect(await statusOf(id)).toBe("accepted");
    expect((await systemOf(id)).decidedByTimeout).toMatchObject({
      option: "bootstrap",
    });
    expect(h.created.map((n) => n.type)).toEqual([
      DECIDED_BY_TIMEOUT_NOTIFICATION_TYPE,
    ]);
    // Decided: the next tick has nothing to do.
    h.created.length = 0;
    expect(await sweepDecisionTimeouts(NOW)).toBe(0);
    expect(h.created).toHaveLength(0);
  });

  it("an AGENT's default never decides: overdue notice once, steps counted (rules out 'timeout = silent auto-accept')", async () => {
    const id = await decision({ answerBy: PAST, defaultOption: "raise" });
    await stampDefaultOptionAuthor(id, await writeEvent(id, AGENT));
    const step = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, title, status, created_at, updated_at)
       values ($1, $2, null, 'Pitch', 'Pitch', 'forming', now(), now())`,
      [step, OWNER]
    );
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
       values (gen_random_uuid(), 'session', $1, 'entity', $2, 'blocked_by', '{"option":"raise"}'::jsonb, now())`,
      [step, id]
    );

    expect(await sweepDecisionTimeouts(NOW)).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(await statusOf(id)).toBe("proposed");
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({
      type: DECISION_OVERDUE_NOTIFICATION_TYPE,
      sourceId: id,
      data: { waitingSteps: 1 },
    });
    // Once per due date.
    expect(await sweepDecisionTimeouts(NOW)).toBe(0);
    expect(h.created).toHaveLength(1);
  });

  it("reminded, then the PERSON sets a default: the next tick applies it (rules out 'reminded once = never looked at again')", async () => {
    const id = await decision({ answerBy: PAST });
    await sweepDecisionTimeouts(NOW);
    expect(h.created.map((n) => n.type)).toEqual([
      DECISION_OVERDUE_NOTIFICATION_TYPE,
    ]);
    await q(
      `update entities set properties = properties || '{"defaultOption":"raise"}'::jsonb where id = $1`,
      [id]
    );
    await stampDefaultOptionAuthor(id, await writeEvent(id, null));
    expect(await sweepDecisionTimeouts(NOW)).toBe(1);
    expect(await statusOf(id)).toBe("accepted");
  });

  it("no default: overdue notice, nothing decided", async () => {
    const id = await decision({ answerBy: PAST });
    expect(await sweepDecisionTimeouts(NOW)).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(await statusOf(id)).toBe("proposed");
    expect(h.created.map((n) => n.type)).toEqual([
      DECISION_OVERDUE_NOTIFICATION_TYPE,
    ]);
  });

  it("CONTROL: not yet due, nothing happens", async () => {
    const id = await decision({ answerBy: FUTURE, defaultOption: "raise" });
    await stampDefaultOptionAuthor(id, await writeEvent(id, null));
    expect(await sweepDecisionTimeouts(NOW)).toBe(0);
    expect(h.updates).toHaveLength(0);
    expect(h.created).toHaveLength(0);
  });
});
