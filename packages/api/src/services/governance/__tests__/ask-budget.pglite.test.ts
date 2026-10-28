/**
 * D7 — the ask budget's ONE counter on real rows (PGlite): the day's ask
 * notifications, joined to their proposals, folded into units and ranked
 * against the person's `daily_ask_count` (default 5, or a ceiling row that
 * names them). The seam the pure tests cannot see: the SQL population (which
 * notifications count, which day), the batch / fingerprint join, and the
 * ceiling read.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
    close: () => Promise<void>;
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

import { askBudget, askLaneOfNotification } from "../ask-budget.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-28T15:00:00.000Z");
const at = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 9, 28, h, m)).toISOString();

beforeAll(async () => {
  await h.client!.exec(`
    CREATE TYPE governance_principal AS ENUM ('agent','any','class');
    CREATE TYPE governance_scope AS ENUM ('workspace','pod');
    CREATE TABLE governance_ceilings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      axis text NOT NULL,
      principal_kind governance_principal NOT NULL,
      agent_user_id text,
      principal_class text,
      scope_kind governance_scope NOT NULL,
      workspace_id uuid,
      subject_type text,
      subject_id text,
      limit_value integer NOT NULL,
      created_by text NOT NULL DEFAULT 'test',
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      expires_at timestamptz
    );
    CREATE TABLE notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      type text NOT NULL,
      source_type text NOT NULL,
      source_id text,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE proposals (
      id uuid PRIMARY KEY,
      proposal_type text NOT NULL,
      target_type text NOT NULL,
      target_id text NOT NULL,
      data jsonb
    );
  `);
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

beforeEach(async () => {
  await h.client!.exec(
    `DELETE FROM notifications; DELETE FROM proposals; DELETE FROM governance_ceilings;`
  );
});

async function notify(
  createdAt: string,
  over: {
    type?: string;
    userId?: string;
    sourceType?: string;
    sourceId?: string;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `INSERT INTO notifications (id, user_id, type, source_type, source_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      over.userId ?? PERSON,
      over.type ?? "session.needs_you",
      over.sourceType ?? "session",
      over.sourceId ?? randomUUID(),
      createdAt,
    ]
  );
  return id;
}

async function proposalAsk(
  createdAt: string,
  data: Record<string, unknown>,
  targetId = randomUUID()
): Promise<string> {
  const pid = randomUUID();
  await h.client!.query(
    `INSERT INTO proposals (id, proposal_type, target_type, target_id, data)
     VALUES ($1, 'update', 'entity', $2, $3::jsonb)`,
    [pid, targetId, JSON.stringify(data)]
  );
  return notify(createdAt, {
    type: "proposal.created",
    sourceType: "proposal",
    sourceId: pid,
  });
}

describe("the ask budget on real rows", () => {
  it("default 5: the 6th ask of the day is in Later", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await notify(at(9, i)));
    const budget = await askBudget(PERSON, NOW);
    expect(budget.limit).toBe(5);
    expect(budget.units.map((u) => u.lane)).toEqual([
      "asks",
      "asks",
      "asks",
      "asks",
      "asks",
      "later",
    ]);
    expect(
      await askLaneOfNotification({
        userId: PERSON,
        type: "session.needs_you",
        notificationId: ids[5]!,
        now: NOW,
      })
    ).toBe("later");
    expect(
      await askLaneOfNotification({
        userId: PERSON,
        type: "session.needs_you",
        notificationId: ids[0]!,
        now: NOW,
      })
    ).toBe("asks");
  });

  it("counts only today's asks to this person — not yesterday, not another person, not a mention", async () => {
    await notify(new Date(Date.UTC(2026, 9, 27, 23, 59)).toISOString());
    await notify(at(9), { userId: OTHER });
    await notify(at(9, 1), { type: "chat.mention" });
    const mine = await notify(at(10));
    const { units } = await askBudget(PERSON, NOW);
    expect(units).toHaveLength(1);
    expect(units[0]!.notificationIds).toEqual([mine]);
  });

  it("Q1: a batch of proposals is one ask; the same change twice is one ask", async () => {
    for (let i = 0; i < 4; i++) {
      await proposalAsk(at(9, i), { batchId: "B1" });
    }
    const target = randomUUID();
    await proposalAsk(at(10), { title: "x" }, target);
    await proposalAsk(at(10, 5), { title: "x" }, target);
    const { units } = await askBudget(PERSON, NOW);
    expect(units.map((u) => u.notificationIds.length)).toEqual([4, 2]);
    expect(units[0]!.key).toBe("batch:B1");
  });

  it("a ceiling row naming the person sets their budget", async () => {
    await h.client!.query(
      `INSERT INTO governance_ceilings (axis, principal_kind, scope_kind, subject_type, subject_id, limit_value)
       VALUES ('daily_ask_count', 'any', 'pod', 'user', $1, 2)`,
      [PERSON]
    );
    for (let i = 0; i < 3; i++) await notify(at(9, i));
    const budget = await askBudget(PERSON, NOW);
    expect(budget.limit).toBe(2);
    expect(budget.units.map((u) => u.lane)).toEqual(["asks", "asks", "later"]);
    expect((await askBudget(OTHER, NOW)).limit).toBe(5);
  });

  it("a type that is not an ask has no lane", async () => {
    const id = await notify(at(9), { type: "chat.mention" });
    expect(
      await askLaneOfNotification({
        userId: PERSON,
        type: "chat.mention",
        notificationId: id,
        now: NOW,
      })
    ).toBeUndefined();
  });
});
