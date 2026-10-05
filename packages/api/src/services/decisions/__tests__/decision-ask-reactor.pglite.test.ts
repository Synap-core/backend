/**
 * W3 of the decision mesh — a `proposed` decision becomes ONE owed ask, driven
 * through the REAL reactor (its `match` + `handler`, as `emitSideEffects`
 * runs it) against PGlite, and answered through the REAL answer door.
 * Stubbed: session creation (inserts the row it would — its own suites own
 * the rest), the needs-you push, the event append, and the decision entity
 * door (CAPTURED — the update an answer makes is asserted).
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
  createdSessions: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: string; properties: Record<string, unknown> }>,
  notified: [] as Array<Record<string, unknown>>,
  closed: [] as Array<Record<string, unknown>>,
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
      schema: {
        focusSessions: actual.focusSessions as never,
        entities: actual.entities as never,
      },
    }),
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));
vi.mock("../../focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async (p: Record<string, unknown>) => {
    h.notified.push(p);
    return true;
  },
}));
vi.mock("../../focus-sessions/accept-on-engagement.js", () => ({
  acceptDraftOnEngagement: async () => undefined,
}));
vi.mock("../../focus-sessions/create-session.js", () => ({
  createFocusSession: async (p: Record<string, unknown>) => {
    h.createdSessions.push(p);
    const id = randomUUID();
    await h.client!.query(
      `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
       values ($1, $2, $3, $4, 'active', '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
      [id, p.userId, p.goal, p.title]
    );
    return { status: "created", session: { id } };
  },
}));
// The ONE close door — its own suites own what a close does; here we assert
// WHICH session the reactor hands it, and stamp the status it would.
vi.mock("../../focus-sessions/complete-session.js", () => ({
  completeFocusSession: async (p: Record<string, unknown>) => {
    h.closed.push(p);
    await h.client!.query(
      `update focus_sessions set status = 'closed' where id = $1`,
      [p.sessionId]
    );
    return { session: { id: p.sessionId } };
  },
}));
vi.mock("../decision-entity-door.js", () => ({
  createDecisionEntity: async () => {
    throw new Error("must not CREATE — the slot names its decision");
  },
  updateDecisionEntity: async (
    _s: unknown,
    id: string,
    properties: Record<string, unknown>
  ) => {
    h.updates.push({ id, properties });
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, entities } from "@synap/database";
import { decisionAskReactor } from "../decision-ask-reactor.js";
import { answerExpectedOutput } from "../../focus-sessions/answer-slot.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
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

async function decision(
  props: Record<string, unknown>,
  createdByKind = "ai_agent"
) {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, system_data, created_by_kind, created_at, updated_at)
     values ($1, $2, null, 'decision', 'Pricing model', $3::jsonb, '{}'::jsonb, $4, now(), now())`,
    [id, OWNER, JSON.stringify(props), createdByKind]
  );
  return id;
}
const setProps = (id: string, props: Record<string, unknown>) =>
  q(`update entities set properties = $2::jsonb where id = $1`, [
    id,
    JSON.stringify(props),
  ]);
async function session(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, 'Pricing work', 'active', '[]'::jsonb, '{agent-1}', '{}'::jsonb, now(), now(), now())`,
    [id, OWNER]
  );
  return id;
}
const fire = (id: string, action: "create" | "update", sessionId?: string) => {
  const payload = {
    subjectType: "entity",
    action,
    subjectId: id,
    userId: OWNER,
    data: { profileSlug: "decision" },
    ...(sessionId ? { sessionId } : {}),
  };
  expect(decisionAskReactor.match!(payload)).toBe(true);
  return decisionAskReactor.handler(payload, { boss: {} as never });
};
const slotsCarrying = async (decisionId: string) =>
  (
    await q<{ id: string; expected_outputs: Array<Record<string, unknown>> }>(
      `select id, expected_outputs from focus_sessions where user_id = $1`,
      [OWNER]
    )
  ).rows.flatMap((r) =>
    r.expected_outputs
      .filter((o) => o.decisionId === decisionId)
      .map((o) => ({ sessionId: r.id, ...o }) as Record<string, unknown>)
  );

const OPTIONS = [
  { label: "Per seat", value: "seat" },
  { label: "Usage based", value: "usage" },
];

describe("a proposed decision asks the person (W3)", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, entities]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  }, 120_000);
  afterAll(async () => h.client?.close());
  beforeEach(() => {
    h.createdSessions.length = 0;
    h.updates.length = 0;
    h.notified.length = 0;
    h.closed.length = 0;
  });

  it("homes the ask in the writing session, as a choose with the recommendation marked", async () => {
    const sid = await session();
    const id = await decision({
      decisionStatus: "proposed",
      decisionOptions: OPTIONS,
      recommendedOption: "usage",
    });
    await fire(id, "create", sid);
    const slots = await slotsCarrying(id);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      sessionId: sid,
      kind: "decision",
      label: "Decide: Pricing model",
      owner: "human",
      blockedReason: "decision",
      decisionId: id,
      ref: { kind: "entity", id },
      ask: {
        mode: "choose",
        options: [
          { label: "Per seat", value: "seat" },
          { label: "Usage based", value: "usage", recommended: true },
        ],
      },
    });
    expect(slots[0]!.owedSince).toBeTruthy();
    expect(h.createdSessions).toHaveLength(0);
    expect(h.notified[0]).toMatchObject({ sessionId: sid, byAgent: true });
  });

  it("is IDEMPOTENT — an update while still proposed never adds a second slot", async () => {
    const sid = await session();
    const id = await decision({ decisionStatus: "proposed" });
    await fire(id, "create", sid);
    await fire(id, "update", sid);
    await fire(id, "update");
    expect(await slotsCarrying(id)).toHaveLength(1);
  });

  // MEASURED BOUNDARY: PGlite serializes these calls, so the second emit's
  // early dedupe always sees the first's write. Deleting the re-check UNDER
  // the row lock (`updateExpectedOutputsLocked`) leaves this test GREEN — it
  // pins the two-emit outcome, not the lock. Real interleaving needs Postgres.
  it("two concurrent emits land ONE slot", async () => {
    const sid = await session();
    const id = await decision({ decisionStatus: "proposed" });
    await Promise.all([fire(id, "create", sid), fire(id, "update", sid)]);
    expect(await slotsCarrying(id)).toHaveLength(1);
  });

  it("no known session ⇒ a minimal 'Decide: <title>' session; no options ⇒ a confirm", async () => {
    const id = await decision({ decisionStatus: "proposed" });
    await fire(id, "create");
    expect(h.createdSessions).toEqual([
      expect.objectContaining({
        userId: OWNER,
        title: "Decide: Pricing model",
        goal: "Decide: Pricing model",
      }),
    ]);
    const [slot] = await slotsCarrying(id);
    expect(slot!.ask).toEqual({
      mode: "confirm",
      prompt: "Accept: Pricing model?",
    });
  });

  it("resolved elsewhere ⇒ the owed slot is retired 'decision_resolved'", async () => {
    const sid = await session();
    const id = await decision({ decisionStatus: "proposed" });
    await fire(id, "create", sid);
    await setProps(id, { decisionStatus: "accepted" });
    await fire(id, "update");
    const [slot] = await slotsCarrying(id);
    expect(slot).toMatchObject({ retiredReason: "decision_resolved" });
    expect(slot!.retiredAt).toBeTruthy();
  });

  it("a non-decision entity is ignored by match", () => {
    expect(
      decisionAskReactor.match!({
        subjectType: "entity",
        action: "create",
        subjectId: "x",
        userId: OWNER,
        data: { profileSlug: "task" },
      })
    ).toBe(false);
  });

  it("answering the slot UPDATES that decision — never files a new one", async () => {
    const sid = await session();
    const id = await decision({
      decisionStatus: "proposed",
      decisionOptions: OPTIONS,
    });
    await fire(id, "create", sid);
    const [slot] = await slotsCarrying(id);
    const r = await answerExpectedOutput({
      sessionId: sid,
      userId: OWNER,
      expectedLabel: slot!.label as string,
      text: "Usage based",
      messageId: null,
      value: { type: "chip", chip: { label: "Usage based", value: "usage" } },
    });
    expect(r.status).toBe("answered");
    expect(h.updates).toEqual([
      {
        id,
        properties: expect.objectContaining({
          decisionStatus: "accepted",
          chosenOption: "usage",
          summary: "Usage based",
        }),
      },
    ]);
    expect((r as { decision?: unknown }).decision).toEqual({
      status: "updated",
      decisionId: id,
    });
  });

  describe("closes the 'Decide:' session it opened, once decided", () => {
    const decideSession = async (id: string) => {
      await fire(id, "create");
      const [slot] = await slotsCarrying(id);
      return slot!.sessionId as string;
    };
    const statusOf = async (sid: string) =>
      (
        await q<{ status: string; metadata: Record<string, unknown> }>(
          `select status, metadata from focus_sessions where id = $1`,
          [sid]
        )
      ).rows[0]!;

    it("marks the session it created, and closes it after the slot is answered", async () => {
      const id = await decision({
        decisionStatus: "proposed",
        decisionOptions: OPTIONS,
      });
      const sid = await decideSession(id);
      expect((await statusOf(sid)).metadata).toMatchObject({
        decisionAskFor: id,
      });
      const [slot] = await slotsCarrying(id);
      await answerExpectedOutput({
        sessionId: sid,
        userId: OWNER,
        expectedLabel: slot!.label as string,
        text: "Usage based",
        messageId: null,
        value: { type: "chip", chip: { label: "Usage based", value: "usage" } },
      });
      // Still open: the answer alone does not close it — the decision update
      // it makes (captured above; its emit replayed here) does.
      expect((await statusOf(sid)).status).toBe("active");
      await setProps(id, h.updates[0]!.properties);
      await fire(id, "update");
      expect(h.closed).toEqual([
        { sessionId: sid, userId: OWNER, summary: "Accepted" },
      ]);
      expect((await statusOf(sid)).status).toBe("closed");
    });

    it("closes it when the decision is resolved elsewhere (slot retired)", async () => {
      const id = await decision({ decisionStatus: "proposed" });
      const sid = await decideSession(id);
      await setProps(id, { decisionStatus: "rejected" });
      await fire(id, "update");
      const [slot] = await slotsCarrying(id);
      expect(slot).toMatchObject({ retiredReason: "decision_resolved" });
      expect(h.closed.map((c) => c.sessionId)).toEqual([sid]);
    });

    it("NEVER closes a session the ask was only homed in (unmarked)", async () => {
      const sid = await session();
      const id = await decision({ decisionStatus: "proposed" });
      await fire(id, "create", sid);
      await setProps(id, { decisionStatus: "accepted" });
      await fire(id, "update");
      expect(h.closed).toEqual([]);
      expect((await statusOf(sid)).status).toBe("active");
    });

    it("keeps it open while something else is still owed there", async () => {
      const id = await decision({ decisionStatus: "proposed" });
      const sid = await decideSession(id);
      await q(
        `update focus_sessions set expected_outputs = expected_outputs || $2::jsonb where id = $1`,
        [sid, JSON.stringify([{ label: "Draft brief", status: "pending" }])]
      );
      await setProps(id, { decisionStatus: "accepted" });
      await fire(id, "update");
      expect(h.closed).toEqual([]);
    });
  });
});
