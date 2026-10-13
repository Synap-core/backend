/**
 * Ticket #12 (D11, option A) — a DECISION is a choice, never a bare "done".
 *
 * A person-owed slot blocked on `decision` with NO ask was closed by a one-tap
 * "I did this" 21 s after its session started. Driven through the REAL doors
 * and read back out of PGlite:
 *
 *   - ATTEST: refused `answer_required` — no stamp, no event, no side effect.
 *   - READS: the owed read and the room's `pendingExpected` both carry the
 *     derived confirm, so every surface draws Yes / No (`askRowRegion` →
 *     `inline`) instead of "I did this".
 *   - ANSWER: a Yes through the answer door closes the slot (hands it back,
 *     answered, owner cleared) and files a decision like any confirm; a bare
 *     free text is refused like on any confirm.
 *   - DECLARE: a decision outcome declared with no ask stores the confirm.
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
  creates: [] as Array<{ input: Record<string, unknown> }>,
}));
vi.mock("../../decisions/decision-entity-door.js", () => ({
  createDecisionEntity: async (
    _scope: Record<string, unknown>,
    input: Record<string, unknown>
  ) => {
    h.creates.push({ input });
    return "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  },
  updateDecisionEntity: async () => undefined,
}));
vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { askFingerprint, askRowRegion } from "@synap-core/types/ask";
import { answerSessionSlot, attestSessionSlot } from "../session-answer.js";
import { projectOwedSlots } from "../owed-outputs.js";
import { joinSessionOutputs } from "../session-outputs.js";
import { splitOutcomes, upsertOutcomes } from "../outcome-declarations.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const LABEL = "Launch scope";
const WHY = "Ship the EU launch with billing included?";
const CONFIRM = { mode: "confirm", prompt: WHY };

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

/** A LEGACY decision slot: stored before the rule, with no ask. */
async function seedDecision(): Promise<string> {
  const id = randomUUID();
  const slot = {
    kind: "decision",
    label: LABEL,
    owner: "human",
    blockedReason: "decision",
    why: WHY,
    owedSince: "2026-10-13T09:00:00.000Z",
  };
  await q(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs, agent_ids, metadata, criteria, workspace_id, project_id, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Launch', 'active', $3::jsonb, '{agent-1}', '{}'::jsonb, '[]'::jsonb, null, null, null, now(), now(), now())`,
    [id, OWNER, JSON.stringify([slot])]
  );
  return id;
}
const stored = async (id: string): Promise<ExpectedOutput[]> =>
  (
    await q<{ expected_outputs: ExpectedOutput[] }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.expected_outputs;

describe("a decision slot is never closed by a bare 'I did this' (#12)", () => {
  beforeAll(async () => {
    await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  }, 120_000);
  afterAll(async () => h.client?.close());
  beforeEach(() => {
    h.events.length = 0;
    h.effects.length = 0;
    h.creates.length = 0;
  });

  it("attest is REFUSED answer_required — no stamp, no event, no side effect", async () => {
    const id = await seedDecision();
    const r = await attestSessionSlot({
      sessionId: id,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(r.status).toBe("answer_required");
    const [slot] = await stored(id);
    expect(slot!.status).toBeUndefined();
    expect(slot!.attestedAt).toBeUndefined();
    expect(h.events).toHaveLength(0);
    expect(h.effects).toHaveLength(0);
  });

  it("both reads hand every surface the derived confirm → the inline Yes / No", async () => {
    const id = await seedDecision();
    const expectedOutputs = await stored(id);
    const [owed] = projectOwedSlots({
      id,
      title: null,
      goal: "Launch",
      status: "active",
      workspaceId: null,
      projectId: null,
      expectedOutputs,
    });
    const { pendingExpected } = joinSessionOutputs({
      artifacts: [],
      produced: [],
      expectedOutputs,
      proposals: [],
      titles: new Map(),
    });
    for (const ask of [owed!.ask, pendingExpected[0]!.ask]) {
      expect(ask).toEqual(CONFIRM);
      expect(askRowRegion(ask as never, { canAnswer: true })).toBe("inline");
    }
  });

  it("a free-text answer is refused like on any confirm; a Yes closes it and files a decision", async () => {
    const id = await seedDecision();
    const words = await answerSessionSlot({
      sessionId: id,
      userId: OWNER,
      expectedLabel: LABEL,
      text: "done",
    });
    expect(words.status).toBe("ask_invalid");
    expect((await stored(id))[0]!.answer).toBeUndefined();

    const yes = await answerSessionSlot({
      sessionId: id,
      userId: OWNER,
      expectedLabel: LABEL,
      value: { type: "confirm", confirmed: true },
      // What the surface rendered: the derived confirm's fingerprint.
      askFingerprint: askFingerprint(CONFIRM as never),
    });
    expect(yes.status).toBe("answered");
    const [slot] = await stored(id);
    // Answered and handed back: no longer the person's, never attested.
    expect(slot!.owner).toBeUndefined();
    expect(slot!.attestedAt).toBeUndefined();
    expect(slot!.answer).toMatchObject({
      text: "Yes",
      question: WHY,
      value: { type: "confirm", confirmed: true },
      askSnapshot: { mode: "confirm", prompt: WHY, chosenKey: "yes" },
    });
    // The decision record, like any confirm.
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]!.input).toMatchObject({
      title: WHY,
      properties: { decisionStatus: "accepted", chosenOption: "yes" },
    });
    expect((yes as { decision?: unknown }).decision).toMatchObject({
      status: "filed",
    });
    expect(slot!.decisionId).toBe("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  });

  it("a decision outcome declared with no ask STORES the confirm; a declared ask is kept", () => {
    const decision = {
      label: LABEL,
      owner: "human" as const,
      blockedReason: "decision" as const,
      why: WHY,
    };
    expect(splitOutcomes([decision]).expectedOutputs[0]!.ask).toEqual(CONFIRM);
    // Upserted onto a stored slot that already asks something: kept.
    const act = { mode: "act" as const, url: "https://example.com" };
    const merged = upsertOutcomes(
      {
        expectedOutputs: [{ kind: "output", label: LABEL, ask: act }],
        criteria: [],
      },
      [decision]
    );
    expect(merged.expectedOutputs[0]!.ask).toEqual(act);
    // Upserted onto a legacy ask-less slot: it gains the confirm.
    const legacy = upsertOutcomes(
      { expectedOutputs: [{ kind: "output", label: LABEL }], criteria: [] },
      [decision]
    );
    expect(legacy.expectedOutputs[0]!.ask).toEqual(CONFIRM);
  });
});
