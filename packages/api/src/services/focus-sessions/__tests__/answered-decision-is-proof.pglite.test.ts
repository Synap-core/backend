/**
 * "An answer that filed its decision IS the proof" (founder, 2 Nov 2026),
 * driven through the REAL doors and read back out of PGlite:
 *
 *   1. DECLARE: an agent's `start_session` declares a decision OUTCOME owned
 *      by the person (`outcomes[]`, `owner: 'human'`, a choose ask) — the row
 *      reads back `owner: 'human'`, owed to the person, with its ask (pod
 *      finding d97535f2 said the owner was lost here: it is not; the answer's
 *      hand-back is what removes `owner`, by design, `answer-slot.ts`).
 *   2. ANSWER: the person picks through the answer door; the pod files the
 *      decision (door captured) and stamps `decisionId`.
 *   3. PROOF: with NO claim from the agent, the outcome projection reads it
 *      met by the answer (`metBy: 'answer'`, the person's, its decision as
 *      evidence), the close gate (`loadOpenRequiredWork`) has nothing open or
 *      waiting, and the owed read no longer counts it. Before this rule the
 *      projection said `met: false` and an agent close was refused NOT_DONE
 *      (session 2c9791ac).
 *
 * Stubbed, and why: governance (granted), project placement (echoes the
 * caller's), the session room, the spawn edge and realtime (own connections),
 * the decision entity door and the links service (their own suites; what is
 * under test is that the answer reaches the door and the slot reads met),
 * events and side effects (captured).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const DECISION = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
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
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    eventRepository: { append: async () => undefined },
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async (
      _db: unknown,
      input: { explicitProjectId?: string | null }
    ) => ({ projectId: input.explicitProjectId ?? null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));
vi.mock("../accept-on-engagement.js", () => ({
  acceptDraftOnEngagement: async () => undefined,
}));
vi.mock("../notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => false,
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));
vi.mock("../assert-output-ref-visible.js", () => ({
  findUnreachableOutputRefs: async () => [],
  unreachableOutputRefError: () => "",
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { ExpectedOutput } from "@synap/playbooks";
import { projectSessionOutcomes } from "@synap-core/types/units";
import { createFocusSession } from "../create-session.js";
import { mergeOutcomesForStart } from "../outcome-declarations.js";
import { answerSessionSlot } from "../session-answer.js";
import {
  loadOpenRequiredWork,
  hasOpenRequiredWork,
} from "../close-not-done.js";
import { joinSessionOutputs } from "../session-outputs.js";
import { isOwedSlot } from "../owed-outputs.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const LABEL = "Tasks model";
const KEY = "d4-tasks";
const WHY = "248 of 314 tasks are todo and nothing closes them";
const ASK = {
  mode: "choose" as const,
  options: [
    { label: "Graph node of an owed outcome", recommended: true },
    { label: "Retire the task kind" },
  ],
};

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const def =
      cfg.name === "focus_sessions" && c.name === "status"
        ? " default 'active'"
        : c.name === "started_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const row = async (id: string) =>
  (
    await q<{
      expected_outputs: ExpectedOutput[];
      criteria: unknown;
      user_id: string;
    }>(
      `select expected_outputs, criteria, user_id from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

/** An agent's start, declaring the decision through `outcomes[]` (MCP's path). */
async function startWithDecisionOutcome(): Promise<string> {
  const declared = mergeOutcomesForStart({
    outcomes: [
      {
        key: KEY,
        label: LABEL,
        kind: "decision",
        owner: "human",
        blockedReason: "decision",
        why: WHY,
        ask: ASK as never,
      },
    ],
  });
  const res = await createFocusSession({
    userId: USER,
    agentUserId: AGENT,
    goal: `Proof first ${randomUUID()}`,
    templateId: null,
    matchTemplate: false,
    forceCreate: true,
    expectedOutputs: declared.expectedOutputs,
    criteria: declared.criteria,
  } as Parameters<typeof createFocusSession>[0]);
  expect(res.status).toBe("created");
  return (res as { session: { id: string } }).session.id;
}

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
}, 120_000);
afterAll(async () => h.client?.close());
beforeEach(() => {
  h.creates.length = 0;
});

describe("an answered decision IS the proof", () => {
  it("a decision outcome declared owner:'human' reads back the person's, owed, with its ask", async () => {
    const id = await startWithDecisionOutcome();
    const [slot] = (await row(id)).expected_outputs;
    expect(slot).toMatchObject({
      key: KEY,
      kind: "decision",
      label: LABEL,
      owner: "human",
      blockedReason: "decision",
      ask: { mode: "choose" },
    });
    expect(isOwedSlot(slot!)).toBe(true);
    const [outcome] = projectSessionOutcomes({
      expectedOutputs: [slot],
      sessionTerminal: false,
    }).outcomes;
    expect(outcome).toMatchObject({ owner: "human", met: false });
  });

  it("the person's answer files the decision and meets the outcome, with no claim from the agent", async () => {
    const id = await startWithDecisionOutcome();
    const answered = await answerSessionSlot({
      sessionId: id,
      userId: USER,
      expectedLabel: LABEL,
      value: {
        type: "chip",
        chip: { label: "Graph node of an owed outcome" },
      } as never,
    });
    expect(answered.status).toBe("answered");
    expect(h.creates).toHaveLength(1);
    // Named by what was decided, never by why it was asked.
    expect(h.creates[0]!.input.title).toBe(LABEL);

    const stored = await row(id);
    const [slot] = stored.expected_outputs;
    expect(slot!.decisionId).toBe(DECISION);
    expect(slot!.claimedDone).toBeUndefined();
    expect(slot!.status).toBeUndefined();
    expect(isOwedSlot(slot!)).toBe(false);

    // The decision, produced in this session, is the outcome's evidence.
    const { outputs, pendingExpected } = joinSessionOutputs({
      artifacts: [],
      produced: [{ toType: "entity", toId: DECISION, createdAt: new Date() }],
      expectedOutputs: stored.expected_outputs,
      proposals: [],
      titles: new Map(),
    });
    expect(pendingExpected).toEqual([]);
    const view = projectSessionOutcomes({
      expectedOutputs: stored.expected_outputs,
      produced: outputs,
      sessionTerminal: false,
    });
    expect(view.outcomes[0]).toMatchObject({
      key: KEY,
      met: true,
      metBy: "answer",
      owner: "human",
    });
    expect(view.outcomes[0]!.state.state).toBe("done");
    expect(view.outcomes[0]!.evidence.map((e) => e.id)).toEqual([
      `entity:${DECISION}`,
    ]);
    expect(view.counts).toEqual({ met: 1, total: 1 });

    // The close gate reads the SAME rule: nothing open, nothing waiting.
    const work = await loadOpenRequiredWork({
      id,
      userId: stored.user_id,
      criteria: stored.criteria as never,
      expectedOutputs: stored.expected_outputs,
    });
    expect(hasOpenRequiredWork(work)).toBe(false);
    expect(work.waiting).toEqual({ criteria: [], outcomes: [] });
  });
});
