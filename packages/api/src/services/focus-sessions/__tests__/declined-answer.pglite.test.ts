/**
 * REFUSE (`{ type: "declined", reason? }`, plan d717d6ac §3, finding
 * 427c440c), through the REAL doors and read back out of PGlite:
 *
 *   1. EVERY MODE: confirm, choose, form, act, provide (a secret) and a slot
 *      with no ask all take a refusal through the one answer door. Rival ruled
 *      out: "act resolves only by attest" and "provide only takes a ref".
 *   2. WHAT IT DOES: the slot goes back to the agent with the answer, the
 *      `slot_answered` event (value `declined`), the room line said as the
 *      person ("Refused: <reason>") and a wake of the pod agent.
 *   3. WHAT IT DOES NOT DO: the slot's blocker (`blocks`, `blockerKey`,
 *      `clearedBy: {answer: true}`) is KEPT, where an ordinary answer clears
 *      it; no decision is filed (the door is captured: zero calls); no draft
 *      is taken on; no secret read is granted (no `vault_grants` row); no run
 *      param is written; the slot never reads decided, even with a
 *      `decisionId` the ask was opened for.
 *   4. RE-ASK: the block door refuses the very ask refused (`ask_refused`),
 *      lets a changed one through, and that changed one archives the refusal.
 *   5. "NOT MINE" (finding 278a866a): the hand-back now writes its history row
 *      and a room line as the person; a slot that was not the person's writes
 *      neither.
 *
 * Stubbed, and why: the decision door and links (captured: under test is that
 * a refusal never reaches them), draft acceptance (captured), the needs-you
 * push and block guidelines (their own suites), events / side effects /
 * `triggerAutoRespond` (captured at the door), realtime (own connections).
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
  triggers: [] as Array<Record<string, unknown>>,
  decisions: [] as unknown[],
  accepted: [] as unknown[],
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
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitSideEffects: async () => undefined };
});
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../utils/channel-visibility.js", async (importOriginal) => {
  const { sql } = await import("drizzle-orm");
  return {
    ...(await importOriginal<
      typeof import("../../../utils/channel-visibility.js")
    >()),
    channelVisibilityWhere: () => sql`true`,
  };
});
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async (
    _userId: string,
    type: string,
    data: Record<string, unknown>
  ) => {
    h.events.push({ type, data });
    return "evt";
  },
}));
vi.mock("../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async (p: Record<string, unknown>) => {
    h.triggers.push(p);
    return true;
  },
}));
vi.mock("../../decisions/decision-entity-door.js", () => ({
  createDecisionEntity: async (...args: unknown[]) => {
    h.decisions.push(args);
    return "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  },
  updateDecisionEntity: async (...args: unknown[]) => {
    h.decisions.push(args);
  },
}));
vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
}));
vi.mock("../accept-on-engagement.js", () => ({
  acceptDraftOnEngagement: async (p: unknown) => {
    h.accepted.push(p);
  },
}));
vi.mock("../notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => false,
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../assert-output-ref-visible.js", () => ({
  findUnreachableOutputRefs: async () => [],
  unreachableOutputRefError: () => "",
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  askFingerprint,
  effectiveSlotAsk,
  type Ask,
} from "@synap-core/types/ask";
import { isDeliverableDelivered } from "@synap-core/types/units";
import { answerSessionSlot, notMineSessionSlot } from "../session-answer.js";
import { blockExpectedOutput } from "../block-output.js";
import { updateFocusSession } from "../update-session.js";
import { DECLINED_REASK_MESSAGE } from "../declined-reask.js";
import {
  FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
  FOCUS_SESSION_SLOT_HANDED_BACK_EVENT_TYPE,
} from "../lifecycle-events.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const IS_AGENT = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "33333333-3333-4333-8333-333333333333";
const LABEL = "GitHub token";
const REASON = "Use the org token, not mine";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const def =
      c.name === "created_at" ||
      c.name === "timestamp" ||
      c.name === "started_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const MODES: Array<[string, Ask | null]> = [
  ["confirm", { mode: "confirm", prompt: "Use your token?" } as Ask],
  [
    "choose",
    {
      mode: "choose",
      options: [{ label: "Mine" }, { label: "The bot's" }],
    } as Ask,
  ],
  [
    "form",
    {
      mode: "form",
      form: {
        fields: [{ key: "repo", label: "Repo", type: "text", required: true }],
      },
    } as Ask,
  ],
  ["act", { mode: "act", steps: ["Create the token on GitHub"] } as Ask],
  [
    "provide",
    {
      mode: "provide",
      provide: { kind: "secret", name: "GITHUB_TOKEN" },
    } as Ask,
  ],
  ["no ask", null],
];

/** One session, one human-owned slot that holds the subject up. */
async function seed(
  ask: Ask | null,
  extra: Record<string, unknown> = {}
): Promise<{ sessionId: string; channelId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Ship', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  const slot = {
    kind: "document",
    label: LABEL,
    owner: "human",
    blockedReason: "credential",
    why: "CI needs a token to open the PR",
    owedSince: "2026-11-16T09:00:00.000Z",
    unblocks: "The PR opens",
    blocks: { entityId: SUBJECT, to: "fixing" },
    blockerKey: "no_token",
    clearedBy: { answer: true },
    ...(ask ? { ask } : {}),
    ...extra,
  };
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Ship', 'Ship', 'active', $3::jsonb, $4, '{}'::jsonb, '[]'::jsonb, $5, now(), now(), now())`,
    [sessionId, OWNER, JSON.stringify([slot]), [IS_AGENT], channelId]
  );
  return { sessionId, channelId };
}

type Slot = ExpectedOutput & Record<string, unknown>;
const slotOf = async (sessionId: string): Promise<Slot> =>
  (
    await q<{ expected_outputs: Slot[] }>(
      `select expected_outputs from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.expected_outputs[0]!;
const roomLines = async (channelId: string) =>
  (
    await q<{ content: string; role: string }>(
      `select content, role from messages where channel_id = $1 order by "timestamp"`,
      [channelId]
    )
  ).rows;

const refuse = (sessionId: string, reason: string | undefined = REASON) =>
  answerSessionSlot({
    sessionId,
    userId: OWNER,
    expectedLabel: LABEL,
    value: { type: "declined", ...(reason ? { reason } : {}) },
  });

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await q(
    `insert into users (id, email, name, timezone, user_type, agent_type) values
      ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
      ($2, 'r@example.test', 'Researcher', 'UTC', 'agent', 'researcher')`,
    [OWNER, IS_AGENT]
  );
}, 120_000);
afterAll(async () => h.client?.close());
beforeEach(() => {
  h.events.length = 0;
  h.triggers.length = 0;
  h.decisions.length = 0;
  h.accepted.length = 0;
});

describe("a refusal goes through the answer door on every mode", () => {
  for (const [mode, ask] of MODES) {
    it(`${mode}: handed back with the answer, the event, the room line and a wake`, async () => {
      const { sessionId, channelId } = await seed(ask);
      const before = await slotOf(sessionId);
      const res = await refuse(sessionId);
      expect(res.status).toBe("answered");

      const slot = await slotOf(sessionId);
      // Back with the agent, the answer on it.
      expect(slot.owner).toBeUndefined();
      expect(slot.ask).toBeUndefined();
      expect(slot.answer).toMatchObject({
        text: `Refused: ${REASON}`,
        value: { type: "declined", reason: REASON },
        answeredBy: OWNER,
        // WHICH ask was refused: the re-ask guard's record.
        askFingerprint: askFingerprint(
          (effectiveSlotAsk(before) as Ask | null) ?? null
        ),
      });
      // Still owed: a no is not a delivery.
      expect(slot.status).toBeUndefined();
      expect(isDeliverableDelivered(slot)).toBe(false);

      // The thing it holds up stays blocked.
      expect(slot.blocks).toEqual({ entityId: SUBJECT, to: "fixing" });
      expect(slot.blockerKey).toBe("no_token");
      expect(slot.clearedBy).toEqual({ answer: true });

      const answered = h.events.filter(
        (e) => e.type === FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE
      );
      expect(answered).toHaveLength(1);
      expect(answered[0]!.data.value).toEqual({
        type: "declined",
        reason: REASON,
      });
      expect(await roomLines(channelId)).toEqual([
        { content: `Refused: ${REASON}`, role: "user" },
      ]);
      expect(h.triggers).toHaveLength(1);
      expect(h.triggers[0]).toMatchObject({ agentType: "researcher" });

      // Nothing granted, nothing decided, nothing taken on.
      expect(h.decisions).toEqual([]);
      expect(h.accepted).toEqual([]);
      if (mode === "provide" || mode === "no ask") {
        expect(res).not.toHaveProperty("secretGrant");
      }
    });
  }

  it("contrast: an ordinary answer DOES clear the blocker the answer clears", async () => {
    const { sessionId } = await seed(MODES[0]![1]);
    const res = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      value: { type: "confirm", confirmed: true },
    });
    expect(res.status).toBe("answered");
    const slot = await slotOf(sessionId);
    expect(slot.blocks).toBeUndefined();
    expect(h.decisions.length).toBeGreaterThan(0);
  });

  it("a decision the ask was opened for stays undecided, and none is filed", async () => {
    const { sessionId } = await seed(
      { mode: "choose", options: [{ label: "EU" }, { label: "US" }] } as Ask,
      { kind: "decision", blockedReason: "decision", decisionId: randomUUID() }
    );
    expect((await refuse(sessionId)).status).toBe("answered");
    const slot = await slotOf(sessionId);
    expect(slot.decisionId).toBeTruthy();
    expect(isDeliverableDelivered(slot)).toBe(false);
    expect(h.decisions).toEqual([]);
  });

  it("a secret refusal grants no read", async () => {
    const { sessionId } = await seed(MODES[4]![1]);
    expect((await refuse(sessionId)).status).toBe("answered");
    const grants = await q<{ n: number }>(
      `select count(*)::int as n from vault_grants`
    );
    expect(grants.rows[0]!.n).toBe(0);
  });

  it("a param slot's refusal writes no run param", async () => {
    const { sessionId } = await seed(
      {
        mode: "choose",
        options: [{ label: "fast" }, { label: "slow" }],
      } as Ask,
      { kind: "param", paramName: "speed" }
    );
    expect((await refuse(sessionId)).status).toBe("answered");
    const meta = (
      await q<{ metadata: Record<string, unknown> }>(
        `select metadata from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!.metadata;
    expect(meta).toEqual({});
  });
});

describe("the same ask cannot be asked again while the refusal stands", () => {
  const ASK = MODES[1]![1] as Ask;

  it("the block door refuses the identical ask, nothing changes", async () => {
    const { sessionId } = await seed(ASK);
    await refuse(sessionId);
    const after = await slotOf(sessionId);
    const res = await blockExpectedOutput({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      blockedReason: "credential",
      ask: ASK as never,
      agentUserId: IS_AGENT,
      unblocks: "The PR opens",
    });
    expect(res).toEqual({
      status: "ask_refused",
      reason: DECLINED_REASK_MESSAGE,
    });
    expect(await slotOf(sessionId)).toEqual(after);
  });

  it("the wholesale patch (update_session, ask_person) refuses it too, nothing changes", async () => {
    const { sessionId } = await seed(ASK);
    await refuse(sessionId);
    const after = await slotOf(sessionId);
    const res = await updateFocusSession({
      sessionId,
      userId: OWNER,
      agentUserId: IS_AGENT,
      expectedOutputs: [
        {
          kind: "document",
          label: LABEL,
          owner: "human",
          blockedReason: "credential",
          why: "CI needs a token to open the PR",
          unblocks: "The PR opens",
          ask: ASK,
        },
      ],
    } as Parameters<typeof updateFocusSession>[0]);
    expect(res).toMatchObject({ status: "denied" });
    expect((res as { reason: string }).reason).toContain(
      DECLINED_REASK_MESSAGE
    );
    expect(await slotOf(sessionId)).toEqual(after);
  });

  it("a changed ask goes through, and the refusal moves to the history", async () => {
    const { sessionId } = await seed(ASK);
    await refuse(sessionId);
    const changed = {
      mode: "choose",
      options: [{ label: "The bot's token" }, { label: "A new org token" }],
    } as Ask;
    const res = await blockExpectedOutput({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
      blockedReason: "credential",
      ask: changed as never,
      agentUserId: IS_AGENT,
      unblocks: "The PR opens",
    });
    expect(res.status).toBe("blocked");
    const slot = await slotOf(sessionId);
    expect(slot.owner).toBe("human");
    expect(slot.answer).toBeUndefined();
    expect(slot.answerHistory?.at(-1)).toMatchObject({
      value: { type: "declined", reason: REASON },
    });
    // The refusal is no longer the standing answer: the old ask is askable again.
    expect(
      (
        await blockExpectedOutput({
          sessionId,
          userId: OWNER,
          expectedLabel: LABEL,
          blockedReason: "credential",
          ask: ASK as never,
          agentUserId: IS_AGENT,
          unblocks: "The PR opens",
        })
      ).status
    ).toBe("blocked");
  });
});

describe('"Not mine" says so', () => {
  it("hands back, writes the history row and the room line as the person", async () => {
    const { sessionId, channelId } = await seed(MODES[0]![1], {
      askedBy: IS_AGENT,
    });
    const res = await notMineSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: LABEL,
    });
    expect(res.status).toBe("unblocked");
    expect((await slotOf(sessionId)).owner).toBeUndefined();
    const rows = h.events.filter(
      (e) => e.type === FOCUS_SESSION_SLOT_HANDED_BACK_EVENT_TYPE
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({
      sessionId,
      expectedLabel: LABEL,
      askMode: "confirm",
      askedBy: IS_AGENT,
      handedBackBy: OWNER,
    });
    expect(await roomLines(channelId)).toEqual([
      { content: `Not mine: ${LABEL}`, role: "user" },
    ]);
    // Not an answer: nobody is woken, nothing is recorded as said.
    expect(h.triggers).toEqual([]);
  });

  it("a slot that was not the person's writes no row and no line", async () => {
    const { sessionId, channelId } = await seed(null, { owner: undefined });
    expect(
      (
        await notMineSessionSlot({
          sessionId,
          userId: OWNER,
          expectedLabel: LABEL,
        })
      ).status
    ).toBe("unblocked");
    expect(
      h.events.filter(
        (e) => e.type === FOCUS_SESSION_SLOT_HANDED_BACK_EVENT_TYPE
      )
    ).toEqual([]);
    expect(await roomLines(channelId)).toEqual([]);
  });
});
