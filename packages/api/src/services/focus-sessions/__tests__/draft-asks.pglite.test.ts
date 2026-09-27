/**
 * DRAFT ASKS, driven through the REAL doors against PGlite (founder decision
 * 2026-09-27, "draft row carries its asks"):
 *
 *   - the read: `listOwedSlots({ onlyDrafts })` returns a pending draft's owed
 *     slots and nothing else; `excludeDrafts` keeps hiding them individually;
 *     `listDraftAskSlots` names the starting agent off the session roster;
 *   - ANSWERING an ask on a pending draft accepts it through the ONE door
 *     (`acceptFromTriage`: `metadata.triage.acceptedAt` + one accepted
 *     event), after which its asks list individually and the draft row's
 *     input is empty;
 *   - ATTESTING ("I did this") accepts it too;
 *   - "Not mine" (unblock) does NOT;
 *   - a second answer is a no-op on acceptance (no second stamp, no event);
 *   - a person's own session is never stamped.
 *
 * Harness copied from `ask-doors.pglite.test.ts` (same stubs, same reasons).
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
  triggers: [] as Array<Record<string, unknown>>,
  /** Make the answer door's post-commit steps throw (best-effort tail). */
  failPost: false,
  failWake: false,
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
        notifications: actual.notifications as never,
        notificationPreferences: actual.notificationPreferences as never,
        users: actual.users as never,
        channels: actual.channels as never,
        channelMembers: actual.channelMembers as never,
        messages: actual.messages as never,
        apiKeys: actual.apiKeys as never,
        proposals: actual.proposals as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
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
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../utils/channel-visibility.js", async () => {
  const { sql } = await import("drizzle-orm");
  return { channelVisibilityWhere: () => sql`true` };
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
    if (h.failWake) throw new Error("pg-boss is down");
    h.triggers.push(p);
    return true;
  },
}));
vi.mock("../../messaging/post-message.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../messaging/post-message.js")>();
  return {
    ...actual,
    postChannelMessage: async (
      p: Parameters<typeof actual.postChannelMessage>[0]
    ) => {
      if (h.failPost && p.idempotencyKey?.startsWith("slot-answer:")) {
        throw new Error("room insert failed");
      }
      return actual.postChannelMessage(p);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  notificationPreferences,
  users,
  channels,
  channelMembers,
  messages,
  apiKeys,
  proposals,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
} from "@synap/database";
import { FOCUS_SESSION_TRIAGE_ACCEPTED_EVENT_TYPE } from "../lifecycle-events.js";
import { answerSessionSlot, attestSessionSlot } from "../session-answer.js";
import { unblockExpectedOutput } from "../block-output.js";
import { listOwedSlots } from "../owed-outputs.js";
import { listDraftAskSlots } from "../draft-asks.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const EXT_AGENT = "44444444-4444-4444-8444-444444444444";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" || c.name === "timestamp" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ASK_A = "Pick a region";
const ASK_B = "Stripe key";
const POD_WIDE = { workspaceLens: undefined, projectLens: undefined };

async function seedSession(opts: {
  origin: "agent" | "human";
  owed: string[];
  agentIds?: string[];
}): Promise<{ sessionId: string }> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Ship billing', now(), now())`,
    [channelId, OWNER]
  );
  await q(
    `insert into channel_members (id, channel_id, member_id, member_kind, created_at) values ($1, $2, $3, 'human', now())`,
    [randomUUID(), channelId, OWNER]
  );
  const sessionId = randomUUID();
  const slots = [
    ...opts.owed.map((label, i) => ({
      kind: "document",
      label,
      owner: "human",
      blockedReason: "decision",
      why: `why ${label}`,
      owedSince: `2026-09-27T0${i + 1}:00:00.000Z`,
    })),
    { kind: "document", label: "Agent work" },
  ];
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, origin, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Ship billing', 'Ship billing', 'active', $3, $4::jsonb, $5, '{}'::jsonb, '[]'::jsonb, $6, now(), now(), now())`,
    [
      sessionId,
      OWNER,
      opts.origin,
      JSON.stringify(slots),
      opts.agentIds ?? [EXT_AGENT],
      channelId,
    ]
  );
  return { sessionId };
}

const triageOf = async (sessionId: string) =>
  (
    await q<{ metadata: { triage?: { acceptedAt?: string } } }>(
      `select metadata from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.metadata.triage;
const accepts = () =>
  h.events.filter((e) => e.type === FOCUS_SESSION_TRIAGE_ACCEPTED_EVENT_TYPE);
const owedIn = async (sessionId: string, lens: "exclude" | "only") =>
  (
    await listOwedSlots({
      userId: OWNER,
      scope: POD_WIDE,
      limit: 100,
      ...(lens === "exclude" ? { excludeDrafts: true } : { onlyDrafts: true }),
    })
  )
    .filter((s) => s.sessionId === sessionId)
    .map((s) => s.label)
    .sort();

describe("draft asks: the read and acceptance on engagement", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      notifications,
      notificationPreferences,
      users,
      channels,
      channelMembers,
      messages,
      apiKeys,
      proposals,
      // The roster's proposal read carries the `userVisibleWhere` floor.
      workspaces,
      workspaceMembers,
      podMembers,
      projectMembers,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
        ($2, 'c@example.test', 'Claude Code', 'UTC', 'agent', 'claude-code')`,
      [OWNER, EXT_AGENT]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(() => {
    h.events.length = 0;
    h.effects.length = 0;
    h.triggers.length = 0;
  });

  it("the read: a draft's asks are ONLY in the draft lens, with the starter named", async () => {
    const { sessionId } = await seedSession({
      origin: "agent",
      owed: [ASK_A, ASK_B],
    });
    expect(await owedIn(sessionId, "only")).toEqual([ASK_A, ASK_B].sort());
    expect(await owedIn(sessionId, "exclude")).toEqual([]);
    const draft = await listDraftAskSlots({
      userId: OWNER,
      scope: POD_WIDE,
      limit: 100,
    });
    expect(draft.slots.filter((s) => s.sessionId === sessionId)).toHaveLength(
      2
    );
    expect(draft.starterNames.get(sessionId)).toBe("Claude Code");
  });

  it("a person's own session is never in the draft lens (and never stamped by an answer)", async () => {
    const { sessionId } = await seedSession({ origin: "human", owed: [ASK_A] });
    expect(await owedIn(sessionId, "only")).toEqual([]);
    expect(await owedIn(sessionId, "exclude")).toEqual([ASK_A]);
    const r = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: ASK_A,
      text: "EU",
    });
    expect(r.status).toBe("answered");
    expect(await triageOf(sessionId)).toBeUndefined();
    expect(accepts()).toHaveLength(0);
  });

  it("ANSWERING an ask accepts the draft: its other asks now list individually", async () => {
    const { sessionId } = await seedSession({
      origin: "agent",
      owed: [ASK_A, ASK_B],
    });
    const r = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: ASK_A,
      text: "EU",
    });
    expect(r.status).toBe("answered");
    const triage = await triageOf(sessionId);
    expect(typeof triage?.acceptedAt).toBe("string");
    expect(accepts()).toHaveLength(1);
    // The draft row's input is gone; the remaining ask is its own row now.
    expect(await owedIn(sessionId, "only")).toEqual([]);
    expect(await owedIn(sessionId, "exclude")).toEqual([ASK_B]);

    // A second answer is a no-op on acceptance: same stamp, no second event.
    const again = await answerSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: ASK_B,
      text: "sk_test is in the vault",
    });
    expect(again.status).toBe("answered");
    expect((await triageOf(sessionId))?.acceptedAt).toBe(triage?.acceptedAt);
    expect(accepts()).toHaveLength(1);
  });

  it("ATTESTING ('I did this') accepts the draft", async () => {
    const { sessionId } = await seedSession({ origin: "agent", owed: [ASK_A] });
    const r = await attestSessionSlot({
      sessionId,
      userId: OWNER,
      expectedLabel: ASK_A,
    });
    expect(r.status).toBe("attested");
    expect(typeof (await triageOf(sessionId))?.acceptedAt).toBe("string");
    expect(accepts()).toHaveLength(1);
  });

  it("'Not mine' (unblock) does NOT accept the draft", async () => {
    const { sessionId } = await seedSession({
      origin: "agent",
      owed: [ASK_A, ASK_B],
    });
    const r = await unblockExpectedOutput({
      sessionId,
      userId: OWNER,
      expectedLabel: ASK_A,
    });
    expect(r.status).not.toBe("not_found");
    expect(await triageOf(sessionId)).toBeUndefined();
    expect(accepts()).toHaveLength(0);
    // Still a draft: the remaining ask stays folded under the draft row.
    expect(await owedIn(sessionId, "only")).toEqual([ASK_B]);
  });
});
