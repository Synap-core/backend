/**
 * W2 of the decision mesh — answer → decision, driven from the REAL answer
 * door, with the decision written through the entity door (CAPTURED here: the
 * canonical `entities.create` router has its own suites; what is under test
 * is that the answer reaches it with the right fields, that the slot is
 * stamped, that a re-answer UPDATES, and that a failure never loses the
 * answer and is never silent).
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
  creates: [] as Array<{
    scope: Record<string, unknown>;
    input: Record<string, unknown>;
  }>,
  updates: [] as Array<{ id: string; properties: Record<string, unknown> }>,
  links: [] as Array<Record<string, unknown>>,
  failCreate: false,
}));
vi.mock("../../decisions/decision-entity-door.js", () => ({
  createDecisionEntity: async (
    scope: Record<string, unknown>,
    input: Record<string, unknown>
  ) => {
    if (h.failCreate) throw new Error("entity door down");
    h.creates.push({ scope, input });
    return "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  },
  updateDecisionEntity: async (
    _s: unknown,
    id: string,
    properties: Record<string, unknown>
  ) => {
    h.updates.push({ id, properties });
  },
}));
vi.mock("../../links/links-service.js", () => ({
  createLinks: async (edges: Array<Record<string, unknown>>) => {
    h.links.push(...edges);
    return [];
  },
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
import { stampBlocked } from "../block-output.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const DECISION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROJECT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const LABEL = "Stripe account";
const WHY = "Which account bills EU customers?";
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

async function seed(ask: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  const slot = {
    kind: "document",
    label: LABEL,
    owner: "human",
    blockedReason: "decision",
    why: WHY,
    owedSince: "2026-10-01T00:00:00.000Z",
    ask,
  };
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, workspace_id, project_id, created_at, updated_at, started_at)
     values ($1, $2, 'Billing', 'active', $3::jsonb, '{agent-1}', '{}'::jsonb, null, $4, now(), now(), now())`,
    [id, OWNER, JSON.stringify([slot]), PROJECT]
  );
  return id;
}
const slotsOf = async (id: string) =>
  (
    await q<{ expected_outputs: Array<Record<string, unknown>> }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs;
const pick = (sessionId: string, value: string, label: string) =>
  answerExpectedOutput({
    sessionId,
    userId: OWNER,
    expectedLabel: LABEL,
    text: label,
    messageId: null,
    value: { type: "chip", chip: { label, value } },
  });

describe("answer → decision (W2)", () => {
  beforeAll(async () => {
    await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  }, 120_000);
  afterAll(async () => h.client?.close());
  beforeEach(() => {
    h.creates.length = 0;
    h.updates.length = 0;
    h.links.length = 0;
    h.failCreate = false;
  });

  it("a choose answer files ONE decision as the person, in the session's project, and stamps the slot", async () => {
    const id = await seed(CHOOSE);
    const r = await pick(id, "us", "US account");
    expect(r.status).toBe("answered");
    expect(h.creates).toHaveLength(1);
    const { scope, input } = h.creates[0]!;
    expect(scope).toEqual({ userId: OWNER, workspaceId: null, sessionId: id });
    expect(input.title).toBe(WHY);
    expect(input.projectId).toBe(PROJECT);
    expect(input.properties).toMatchObject({
      summary: "US account",
      decisionStatus: "accepted",
      chosenOption: "us",
      recommendedOption: "eu",
      followedRecommendation: false,
      decisionOptions: CHOOSE.options,
      sourceSessionId: id,
      askedByAgent: "agent-1",
    });
    expect(h.links).toEqual([
      expect.objectContaining({
        fromId: DECISION,
        toType: "entity",
        toId: "e-1",
        linkType: "about",
      }),
    ]);
    expect((await slotsOf(id))[0]!.decisionId).toBe(DECISION);
    expect((r as { decision?: unknown }).decision).toEqual({
      status: "filed",
      decisionId: DECISION,
      slotStamped: true,
    });
  });

  it("re-asked and re-answered, the slot UPDATES its decision — never a second one", async () => {
    const id = await seed(CHOOSE);
    await pick(id, "us", "US account");
    // The agent re-asks the same slot.
    const reasked = stampBlocked(
      (await slotsOf(id)) as never,
      LABEL,
      "decision",
      WHY,
      undefined,
      undefined,
      CHOOSE as never
    );
    await q(
      `update focus_sessions set expected_outputs = $2::jsonb where id = $1`,
      [id, JSON.stringify(reasked)]
    );
    h.creates.length = 0;
    const r = await pick(id, "eu", "EU account");
    expect(h.creates).toHaveLength(0);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.id).toBe(DECISION);
    expect(h.updates[0]!.properties).toMatchObject({
      chosenOption: "eu",
      followedRecommendation: true,
    });
    expect((r as { decision?: unknown }).decision).toEqual({
      status: "updated",
      decisionId: DECISION,
    });
  });

  it("a form answer files nothing", async () => {
    const id = await seed({
      mode: "form",
      form: { fields: [{ key: "notes", label: "Notes", type: "text" }] },
    });
    const r = await answerExpectedOutput({
      sessionId: id,
      userId: OWNER,
      expectedLabel: LABEL,
      text: "Notes: hi",
      messageId: null,
      value: { type: "form", values: { notes: "hi" } },
    });
    expect(r.status).toBe("answered");
    expect(h.creates).toHaveLength(0);
    expect(r).not.toHaveProperty("decision");
  });

  it("a failed filing keeps the answer and SAYS it failed", async () => {
    const id = await seed(CHOOSE);
    h.failCreate = true;
    const r = await pick(id, "us", "US account");
    expect(r.status).toBe("answered");
    expect((r as { decision?: unknown }).decision).toEqual({
      status: "failed",
      reason: "entity door down",
    });
    const [slot] = await slotsOf(id);
    expect(slot!.answer).toBeTruthy();
    expect(slot!.decisionId).toBeUndefined();
  });
});
