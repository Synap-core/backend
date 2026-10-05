/**
 * W1 of the decision mesh, through the REAL doors and read back out of
 * PGlite: the answer door freezes the ask as posed onto the stored answer AND
 * onto the `slot_answered` event; the block door records the ask as posed
 * (`slot_asked`). Stubbed: the event append + reactor hop (CAPTURED — they are
 * what is asserted), the needs-you push and block guidance (own suites).
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
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  events: [] as Array<{ type: string; data: Record<string, unknown> }>,
  effects: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: { focusSessions: actual.focusSessions as never },
    }),
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    emitSideEffects: async (p: Record<string, unknown>) => {
      h.effects.push(p);
    },
  };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async (_u: string, type: string, data: Record<string, unknown>) => {
    h.events.push({ type, data });
    return "evt";
  },
}));
vi.mock("../accept-on-engagement.js", () => ({
  acceptDraftOnEngagement: async () => undefined,
}));
vi.mock("../notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => false,
}));
vi.mock("../block-guidelines.js", () => ({
  guidanceForBlockedSlots: async () => undefined,
}));
vi.mock("../assert-output-ref-visible.js", () => ({
  findUnreachableOutputRefs: async () => [],
  unreachableOutputRefError: () => "",
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { answerExpectedOutput } from "../answer-slot.js";
import { blockExpectedOutput } from "../block-output.js";
import {
  FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
} from "../lifecycle-events.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const LABEL = "Stripe account";
const CHOOSE = {
  mode: "choose",
  options: [
    { label: "EU account", value: "eu", recommended: true },
    { label: "US account", value: "us" },
  ],
  lookedAt: [{ kind: "entity", id: "e-1" }],
};

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seed(slot: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Billing', 'active', $3::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [id, OWNER, JSON.stringify([slot])]
  );
  return id;
}
const slotOf = async (id: string) =>
  (
    await q<{ expected_outputs: Array<Record<string, unknown>> }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs[0]!;

describe("the ask is kept when answered (W1)", () => {
  beforeAll(async () => {
    await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  }, 120_000);
  afterAll(async () => h.client?.close());
  beforeEach(() => {
    h.events.length = 0;
    h.effects.length = 0;
  });

  it("freezes options, recommendation, pick and lookedAt — on the slot AND the event", async () => {
    const id = await seed({
      kind: "document",
      label: LABEL,
      owner: "human",
      blockedReason: "decision",
      why: "Which account bills the EU customers?",
      owedSince: "2026-10-01T00:00:00.000Z",
      ask: CHOOSE,
    });
    const r = await answerExpectedOutput({
      sessionId: id,
      userId: OWNER,
      expectedLabel: LABEL,
      text: "US account",
      messageId: null,
      value: { type: "chip", chip: { label: "US account", value: "us" } },
    });
    expect(r.status).toBe("answered");

    const stored = await slotOf(id);
    // The hand-back cleared the ask…
    expect(stored.ask).toBeUndefined();
    // …and the answer kept it.
    const snap = (stored.answer as Record<string, unknown>).askSnapshot;
    expect(snap).toEqual({
      mode: "choose",
      why: "Which account bills the EU customers?",
      options: CHOOSE.options,
      chosenKey: "us",
      recommendedKey: "eu",
      followedRecommendation: false,
      lookedAt: [{ kind: "entity", id: "e-1" }],
    });

    const ev = h.events.filter(
      (e) => e.type === FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data.askSnapshot).toEqual(snap);
    const fx = h.effects.filter((e) => e.action === "slot_answered");
    expect((fx[0]!.data as Record<string, unknown>).askSnapshot).toEqual(snap);
  });

  it("an answer to a slot with no ask carries no snapshot (null on the event)", async () => {
    const id = await seed({
      kind: "document",
      label: LABEL,
      owner: "human",
      blockedReason: "decision",
      why: "Anything?",
    });
    await answerExpectedOutput({
      sessionId: id,
      userId: OWNER,
      expectedLabel: LABEL,
      text: "Go",
      messageId: null,
    });
    expect((await slotOf(id)).answer).not.toHaveProperty("askSnapshot");
    const ev = h.events.find(
      (e) => e.type === FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE
    )!;
    expect(ev.data.askSnapshot).toBeNull();
  });

  it("the block door records the ask AS POSED (slot_asked), once", async () => {
    const id = await seed({ kind: "document", label: LABEL });
    const r = await blockExpectedOutput({
      sessionId: id,
      userId: OWNER,
      expectedLabel: LABEL,
      blockedReason: "decision",
      why: "Which account?",
      ask: CHOOSE as never,
      agentUserId: "agent-1",
    });
    expect(r.status).toBe("blocked");
    const asked = h.events.filter(
      (e) => e.type === FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.data).toMatchObject({
      sessionId: id,
      expectedLabel: LABEL,
      blockedReason: "decision",
      why: "Which account?",
      ask: CHOOSE,
      askedByAgentUserId: "agent-1",
    });

    // Re-posing the SAME ask is not a second question.
    await blockExpectedOutput({
      sessionId: id,
      userId: OWNER,
      expectedLabel: LABEL,
      blockedReason: "decision",
      ask: CHOOSE as never,
    });
    expect(
      h.events.filter((e) => e.type === FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE)
    ).toHaveLength(1);
  });
});
