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
  asked: [] as Array<Record<string, unknown>>,
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
        podSettings: actual.podSettings as never,
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
  logEvent: async (_u: string, type: string, data: Record<string, unknown>) => {
    if (type.includes("slot_asked")) h.asked.push(data);
    return "evt";
  },
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
import { focusSessions, entities, podSettings } from "@synap/database";
import { decisionAskReactor } from "../decision-ask-reactor.js";
import { retireUnaskedDecisionAsks } from "../retire-unasked-decision-asks.js";
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

const AGENT = "22222222-2222-4222-8222-222222222222";
async function decision(
  props: Record<string, unknown>,
  createdByKind: string | null = "ai_agent"
) {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, system_data, created_by_kind, agent_user_id, created_at, updated_at)
     values ($1, $2, null, 'decision', 'Pricing model', $3::jsonb, '{}'::jsonb, $4, $5, now(), now())`,
    [
      id,
      OWNER,
      JSON.stringify(props),
      createdByKind,
      createdByKind === "ai_agent" ? AGENT : null,
    ]
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
const fire = (
  id: string,
  action: "create" | "update",
  sessionId?: string,
  data: Record<string, unknown> = {}
) => {
  const payload = {
    subjectType: "entity",
    action,
    subjectId: id,
    userId: OWNER,
    data: { profileSlug: "decision", ...data },
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
    for (const t of [focusSessions, entities, podSettings]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  }, 120_000);
  afterAll(async () => h.client?.close());
  beforeEach(() => {
    h.createdSessions.length = 0;
    h.updates.length = 0;
    h.notified.length = 0;
    h.closed.length = 0;
    h.asked.length = 0;
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
      label: "Pricing model",
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

  it("no known session ⇒ a one-slot session named after it; no options ⇒ a confirm that says what each answer does", async () => {
    const id = await decision({
      decisionStatus: "proposed",
      summary: "Pricing model",
    });
    await fire(id, "create");
    expect(h.createdSessions).toEqual([
      expect.objectContaining({ userId: OWNER, title: "Pricing model" }),
    ]);
    const [slot] = await slotsCarrying(id);
    // Said once: the label is the title, never "Decide: …"; the summary that
    // only restates the title is not repeated as the why.
    expect(slot!.label).toBe("Pricing model");
    expect(slot).not.toHaveProperty("why");
    // No prompt: the title heads the card, the answers say what they do.
    expect(slot!.ask).toEqual({
      mode: "confirm",
      yes: { label: "Accept", description: "Marks it accepted" },
      no: { label: "Reject", description: "Marks it rejected" },
    });
    // The asker and the cause, stamped server-side: the card's door.
    expect(slot).toMatchObject({
      askedBy: AGENT,
      askCause: { kind: "decision", ref: { kind: "entity", id } },
    });
  });

  it("the why is what the summary says beyond the title", async () => {
    const other = await decision({
      decisionStatus: "proposed",
      summary: "Seats are what buyers compare today.",
    });
    // The 10-18 backfill shape: the title is the summary's first sentence.
    const opened = await decision({
      decisionStatus: "proposed",
      summary: "Pricing model. Seats until usage data exists.",
    });
    for (const id of [other, opened]) await fire(id, "create");
    expect((await slotsCarrying(other))[0]!.why).toBe(
      "Seats are what buyers compare today."
    );
    expect((await slotsCarrying(opened))[0]!.why).toBe(
      "Seats until usage data exists."
    );
  });

  it("strips the title the summary opens with in any case — never drops the rest", async () => {
    // One fold for "does it restate" and "what is left": the summary opens
    // with the title in another case, and still says something beyond it.
    const id = await decision({
      decisionStatus: "proposed",
      summary: "pricing model: three tiers, reviewed yearly.",
    });
    await fire(id, "create");
    expect((await slotsCarrying(id))[0]!.why).toBe(
      "three tiers, reviewed yearly."
    );
  });

  it("two decisions with one title in one session: an ordinal, never an id fragment", async () => {
    const sid = await session();
    const first = await decision({ decisionStatus: "proposed" });
    const second = await decision({ decisionStatus: "proposed" });
    await fire(first, "create", sid);
    await fire(second, "create", sid);
    expect((await slotsCarrying(first))[0]!.label).toBe("Pricing model");
    // The label heads the card on every surface.
    expect((await slotsCarrying(second))[0]!.label).toBe("Pricing model (2)");
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

  // W7: a decision's status MOVE arrives on the status door's transition;
  // the update the door still dual-emits for it is not seen a second time.
  const move = (
    id: string,
    from: string,
    to: string,
    role: string | null = null
  ) => ({
    subjectType: "entity",
    action: "transition",
    subjectId: id,
    userId: OWNER,
    data: {
      transitionId: `t-${id}-${to}`,
      entityId: id,
      profileSlug: "decision",
      role,
      lifecycleProfile: role ?? "decision",
      property: "decisionStatus",
      from,
      to,
    },
  });
  const dualUpdate = (id: string, from: string, to: string) => ({
    subjectType: "entity",
    action: "update",
    subjectId: id,
    userId: OWNER,
    data: {
      profileSlug: "decision",
      transitionId: `t-${id}-${to}`,
      changedKeys: ["decisionStatus"],
      "changed.decisionStatus": true,
      "previous.decisionStatus": from,
      decisionStatus: to,
    },
  });

  it("a MOVE into proposed asks on its transition; the move's dual-emitted update is not matched", async () => {
    const sid = await session();
    const id = await decision({ decisionStatus: "accepted" });
    await setProps(id, { decisionStatus: "proposed" });
    const tr = { ...move(id, "accepted", "proposed"), sessionId: sid };
    expect(decisionAskReactor.match!(tr)).toBe(true);
    await decisionAskReactor.handler(tr, { boss: {} as never });
    expect(await slotsCarrying(id)).toHaveLength(1);
    expect(
      decisionAskReactor.match!(dualUpdate(id, "accepted", "proposed"))
    ).toBe(false);
  });

  it("a MOVE out of proposed retires the ask on its transition", async () => {
    const sid = await session();
    const id = await decision({ decisionStatus: "proposed" });
    await fire(id, "create", sid);
    await setProps(id, { decisionStatus: "rejected" });
    const tr = move(id, "proposed", "rejected");
    expect(decisionAskReactor.match!(tr)).toBe(true);
    await decisionAskReactor.handler(tr, { boss: {} as never });
    const [slot] = await slotsCarrying(id);
    expect(slot).toMatchObject({ retiredReason: "decision_resolved" });
  });

  it("a ROLE's move on a decision entity is not the decision's own move", () => {
    const id = randomUUID();
    expect(decisionAskReactor.match!(move(id, "a", "b", "client"))).toBe(false);
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
        }),
      },
    ]);
    expect((r as { decision?: unknown }).decision).toEqual({
      status: "updated",
      decisionId: id,
    });
  });

  it("answering NEVER rewrites the person's summary, options or rationale; the note is appended", async () => {
    const sid = await session();
    const id = await decision({
      decisionStatus: "proposed",
      summary: "Four observations will confirm or kill H1 and H2",
      rationale: "Dated, falsifiable.",
    });
    await fire(id, "create", sid);
    const [slot] = await slotsCarrying(id);
    await answerExpectedOutput({
      sessionId: sid,
      userId: OWNER,
      expectedLabel: slot!.label as string,
      text: "No — not before the October data",
      messageId: null,
      value: { type: "confirm", confirmed: false },
    });
    const [update] = h.updates;
    expect(update!.properties).toMatchObject({
      decisionStatus: "rejected",
      chosenOption: "no",
      rationale:
        "Dated, falsifiable.\n\nWhen deciding: not before the October data",
    });
    for (const key of ["summary", "decisionOptions", "alternatives"]) {
      expect(update!.properties).not.toHaveProperty(key);
    }
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
  describe("asks only when an AGENT puts a decision into proposed", () => {
    it("a person's own proposed decision asks nothing", async () => {
      const id = await decision({ decisionStatus: "proposed" }, null);
      await fire(id, "create");
      expect(await slotsCarrying(id)).toEqual([]);
      expect(h.createdSessions).toEqual([]);
    });

    it("an edit of a proposed decision that does not move its status asks nothing (the title backfill)", async () => {
      const id = await decision({ decisionStatus: "proposed" });
      await fire(id, "update", undefined, {
        changedKeys: ["summary"],
        "changed.summary": true,
      });
      expect(await slotsCarrying(id)).toEqual([]);
    });

    it("a move INTO proposed asks, and names the agent on the slot_asked row", async () => {
      const id = await decision({ decisionStatus: "proposed" });
      await fire(id, "update", undefined, {
        changedKeys: ["decisionStatus"],
        "changed.decisionStatus": true,
        "previous.decisionStatus": "accepted",
        decisionStatus: "proposed",
      });
      expect(await slotsCarrying(id)).toHaveLength(1);
      expect(h.asked).toEqual([
        expect.objectContaining({ askedByAgentUserId: AGENT, decisionId: id }),
      ]);
    });
  });

  describe("retires the asks nobody asked (not_asked), once, through the close door", () => {
    beforeEach(() => q(`delete from pod_settings`));
    // The shape the old reactor left: a person's decision, asked in a
    // Decide session it opened (marked), with nothing else owed there.
    const legacyAsk = async (
      decisionId: string,
      marked: boolean,
      extra: unknown[] = [],
      over: Record<string, unknown> = {}
    ) => {
      const sid = randomUUID();
      await q(
        `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
         values ($1, $2, 'Decide: Pricing model', 'active', $3::jsonb, '{}', $4::jsonb, now(), now(), now())`,
        [
          sid,
          OWNER,
          JSON.stringify([
            {
              kind: "decision",
              label: `Decide: Pricing model (${decisionId.slice(0, 8)})`,
              status: "pending",
              owner: "human",
              blockedReason: "decision",
              owedSince: "2026-10-18T10:00:00.000Z",
              ask: { mode: "confirm", prompt: "Accept: Pricing model?" },
              ref: { kind: "entity", id: decisionId },
              decisionId,
              ...over,
            },
            ...extra,
          ]),
          JSON.stringify(marked ? { decisionAskFor: decisionId } : {}),
        ]
      );
      return sid;
    };
    const statusOf = async (sid: string) =>
      (
        await q<{ status: string }>(
          `select status from focus_sessions where id = $1`,
          [sid]
        )
      ).rows[0]!.status;

    it("retires the person's asks, closes only the settled Decide sessions, leaves an agent's ask, and a rerun touches nothing", async () => {
      await q(`delete from focus_sessions`);
      const mine = await decision({ decisionStatus: "proposed" }, null);
      const mine2 = await decision({ decisionStatus: "proposed" }, "human");
      const busy = await decision({ decisionStatus: "proposed" }, null);
      const agents = await decision({ decisionStatus: "proposed" });
      const s1 = await legacyAsk(mine, true);
      const s2 = await legacyAsk(mine2, true);
      const s3 = await legacyAsk(busy, true, [
        { label: "Draft brief", status: "pending" },
      ]);
      const s4 = await legacyAsk(agents, true);

      expect(await retireUnaskedDecisionAsks()).toEqual({
        status: "completed",
        retiredSlots: 3,
        closedSessions: 2,
      });
      for (const id of [mine, mine2, busy]) {
        const [slot] = await slotsCarrying(id);
        expect(slot).toMatchObject({ retiredReason: "not_asked" });
      }
      expect((await slotsCarrying(agents))[0]).not.toHaveProperty("retiredAt");
      expect(h.closed.map((c) => c.sessionId).sort()).toEqual([s1, s2].sort());
      for (const c of h.closed) {
        expect(c).toMatchObject({
          userId: OWNER,
          summary: "Not asked by anyone",
        });
      }
      expect(await statusOf(s3)).toBe("active");
      expect(await statusOf(s4)).toBe("active");

      // Run once: the marker answers every later boot.
      expect(await retireUnaskedDecisionAsks()).toEqual({
        status: "already-complete",
        retiredSlots: 0,
        closedSessions: 0,
      });
    });

    it("never retires a question somebody asked: re-asked after an answer, asked by a named agent, or filed from an answer", async () => {
      await q(`delete from focus_sessions`);
      // Answered, then re-asked ("Not what I said", an agent's block).
      const reasked = await decision({ decisionStatus: "proposed" }, null);
      await legacyAsk(reasked, false, [], {
        answerHistory: [
          {
            text: "Yes",
            answeredBy: OWNER,
            answeredAt: "2026-10-20T10:00:00.000Z",
          },
        ],
      });
      // Asked by a named agent.
      const named = await decision({ decisionStatus: "proposed" }, null);
      await legacyAsk(named, false, [], { askedBy: AGENT });
      // A decision an answer FILED: the slot's ref is not the decision.
      const filed = await decision({ decisionStatus: "proposed" }, "human");
      await legacyAsk(filed, false, [], {
        ref: { kind: "entity", id: randomUUID() },
      });

      expect(await retireUnaskedDecisionAsks()).toEqual({
        status: "completed",
        retiredSlots: 0,
        closedSessions: 0,
      });
      for (const id of [reasked, named, filed]) {
        expect((await slotsCarrying(id))[0]).not.toHaveProperty("retiredAt");
      }
    });
  });
});
