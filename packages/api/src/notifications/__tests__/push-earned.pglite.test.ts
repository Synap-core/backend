/**
 * W8 "Phone magic" — does a notification EARN a push, and does a blocking
 * ask's push carry what the lock screen needs? Driven through the REAL doors
 * and read back out of PGlite.
 *
 * 1. `proposal.created` pushes ONLY when the proposal blocks an open session
 *    or run (`push-decision.ts`): an explicit, open session ⇒ push; a derived
 *    receipt session, a closed session, no session ⇒ the row is written (the
 *    tray still shows it) and NO push. A per-TYPE `"all"` rule still forces it.
 * 2. Push categories are the person's, on their POD-WIDE row
 *    (`writePushPrefs` → `notification_preferences.push_prefs`): a category
 *    turned off stops its pushes; a workspace override row never shadows it.
 * 3. A blocking ask (`blockExpectedOutput` with a typed ask) pushes to
 *    `owed/<sessionId>?slot=<label>`, time-sensitive, threaded by session,
 *    with a quick answer — and that quick answer, sent unchanged through the
 *    owed page's own answer service, ANSWERS the slot (the seam, not a shape).
 *
 * 4. The lock-screen "I did it" (an `act` ask) goes through the attest door
 *    BOUND to the ask it showed: the same fingerprint attests; a re-asked
 *    slot is refused `ask_changed` instead of attesting a different question.
 *
 * Real: the doors above, `NotificationService.create`, `push-decision`,
 * `push-prefs`, `answerSessionSlot`, the tables. Stubbed: Expo + socket (no
 * transport; captured), governance (granted), side-effect emitters.
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
  pushes: [] as Array<Record<string, unknown>>,
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
        proposals: actual.proposals as never,
        messages: actual.messages as never,
        apiKeys: actual.apiKeys as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("../expo-push.js", () => ({
  sendExpoPush: async (input: Record<string, unknown>) => {
    h.pushes.push(input);
    return { sent: 1, revoked: 0, failed: 0 };
  },
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));
vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, checkPermissionOrPropose: async () => ({ granted: true }) };
});
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});
vi.mock("../../lib/event-helpers.js", () => ({ logEvent: async () => undefined }));
vi.mock(
  "../../services/focus-sessions/block-guidelines.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, guidanceForBlockedSlots: async () => undefined };
  }
);
vi.mock("../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  notificationPreferences,
  users,
  proposals,
  messages,
  apiKeys,
} from "@synap/database";
import { askFingerprint, type Ask } from "@synap-core/types/ask";
import type { PushQuickAnswer } from "@synap-core/types/push";
import { NotificationService } from "../NotificationService.js";
import { writePushPrefs, readPushPrefs } from "../push-prefs.js";
import { blockExpectedOutput } from "../../services/focus-sessions/block-output.js";
import {
  answerSessionSlot,
  attestSessionSlot,
} from "../../services/focus-sessions/session-answer.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
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

const SLOTS = [{ kind: "document", label: "Tone", status: "pending" }];

async function seedSession(status = "active"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, created_at, updated_at, started_at)
     values ($1, $2, 'Post', 'LinkedIn post', $3, $4::jsonb, $5, '{}'::jsonb, '[]'::jsonb, now(), now(), now())`,
    [id, USER, status, JSON.stringify(SLOTS), []]
  );
  return id;
}

async function seedProposal(opts: {
  sessionId?: string | null;
  derived?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, workspace_id, target_type, proposal_type, status, data, session_id, created_at, updated_at)
     values ($1, $2, 'entity', 'create', 'pending', $3::jsonb, $4, now(), now())`,
    [
      id,
      WORKSPACE,
      JSON.stringify(opts.derived ? { sessionSource: "derived" } : {}),
      opts.sessionId ?? null,
    ]
  );
  return id;
}

const proposalCreated = (proposalId: string) =>
  NotificationService.create({
    type: "proposal.created",
    workspaceId: WORKSPACE,
    userId: USER,
    sourceType: "proposal",
    sourceId: proposalId,
    data: { proposalType: "entity.create", description: "Create ACME" },
  });

const rowsFor = (sourceId: string) =>
  q<{ id: string }>(`select id from notifications where source_id = $1`, [
    sourceId,
  ]).then((r) => r.rows);

describe("W8 — a push is earned", () => {
  beforeAll(async () => {
    for (const t of [
      focusSessions,
      notifications,
      notificationPreferences,
      users,
      proposals,
      messages,
      apiKeys,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `alter table notifications alter column status set default 'unread'`
    );
    await h.client!.exec(
      `alter table notification_preferences alter column enabled set default true`
    );
    await q(
      `insert into users (id, email, name, timezone) values ($1, 'a@example.test', 'Antoine', 'UTC'), ($2, 'agent@example.test', 'Claude Code', 'UTC')`,
      [USER, AGENT]
    );
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    h.pushes.length = 0;
    await q(`delete from notifications`);
    await q(`delete from notification_preferences`);
  });

  // ── 1. proposal pushes only when blocking ──────────────────────────────────
  it("a proposal filed from an OPEN session the agent named pushes, time-sensitive", async () => {
    const p = await seedProposal({ sessionId: await seedSession("active") });
    expect(await proposalCreated(p)).toBeTruthy();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({
      interruptionLevel: "time-sensitive",
      sound: "default",
      data: { pushCategory: "decision-blocking", kind: "proposal", id: p },
    });
  });

  it("a DERIVED receipt session blocks nothing — row written, no push", async () => {
    const p = await seedProposal({
      sessionId: await seedSession("active"),
      derived: true,
    });
    expect(await proposalCreated(p)).toBeTruthy();
    expect(await rowsFor(p)).toHaveLength(1);
    expect(h.pushes).toHaveLength(0);
  });

  it("a CLOSED session blocks nothing — no push", async () => {
    const p = await seedProposal({ sessionId: await seedSession("closed") });
    await proposalCreated(p);
    expect(await rowsFor(p)).toHaveLength(1);
    expect(h.pushes).toHaveLength(0);
  });

  it("a proposal with no session (pod-wide recommendation shape) — no push", async () => {
    const p = await seedProposal({ sessionId: null });
    await proposalCreated(p);
    expect(await rowsFor(p)).toHaveLength(1);
    expect(h.pushes).toHaveLength(0);
  });

  it("a per-TYPE 'all' rule the person set still forces the push", async () => {
    await q(
      `insert into notification_preferences (id, user_id, workspace_id, enabled, routing_rules) values ($1, $2, null, true, $3::jsonb)`,
      [randomUUID(), USER, JSON.stringify({ "proposal.created": "all" })]
    );
    const p = await seedProposal({ sessionId: null });
    await proposalCreated(p);
    expect(h.pushes).toHaveLength(1);
  });

  // ── 2. categories are the person's ────────────────────────────────────────
  it("turning a category off stops its pushes; the tray row still lands", async () => {
    await writePushPrefs(USER, { categories: { "decision-blocking": false } });
    const p = await seedProposal({ sessionId: await seedSession("active") });
    await proposalCreated(p);
    expect(await rowsFor(p)).toHaveLength(1);
    expect(h.pushes).toHaveLength(0);
  });

  it("a workspace override row does not shadow the pod-wide push prefs", async () => {
    await writePushPrefs(USER, { categories: { "decision-blocking": false } });
    await q(
      `insert into notification_preferences (id, user_id, workspace_id, enabled, routing_rules, push_prefs) values ($1, $2, $3, true, '{}'::jsonb, '{}'::jsonb)`,
      [randomUUID(), USER, WORKSPACE]
    );
    const p = await seedProposal({ sessionId: await seedSession("active") });
    await proposalCreated(p);
    expect(h.pushes).toHaveLength(0);
  });

  it("writes MERGE: a second category does not erase the first; bad keys are dropped", async () => {
    await writePushPrefs(USER, { categories: { "decision-blocking": false } });
    await writePushPrefs(USER, {
      categories: { system: true, bogus: true } as never,
      morningBriefAt: "07:15",
    });
    expect(await readPushPrefs(USER)).toEqual({
      categories: { "decision-blocking": false, system: true },
      morningBriefAt: "07:15",
    });
    const pod = await q<{ n: number }>(
      `select count(*)::int as n from notification_preferences where user_id = $1 and workspace_id is null`,
      [USER]
    );
    expect(pod.rows[0]!.n).toBe(1);
  });

  // ── 3. the blocking ask's push, and its quick answer through the real door ─
  it("a typed confirm ask pushes to the ASK with a quick answer that answers it", async () => {
    const sessionId = await seedSession("active");
    const ask: Ask = { mode: "confirm", prompt: "Casual tone?" };
    const r = await blockExpectedOutput({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      expectedLabel: "Tone",
      blockedReason: "decision",
      why: "casual or formal",
      ask,
    } as Parameters<typeof blockExpectedOutput>[0]);
    expect(r.status).toBe("blocked");

    expect(h.pushes).toHaveLength(1);
    const push = h.pushes[0] as {
      interruptionLevel: string;
      threadId: string;
      categoryId: string;
      data: Record<string, unknown>;
    };
    expect(push.interruptionLevel).toBe("time-sensitive");
    expect(push.threadId).toBe(sessionId);
    expect(push.categoryId).toBe("ask-confirm");
    expect(push.data).toMatchObject({
      pushCategory: "blocking-ask",
      kind: "owed",
      id: sessionId,
      slot: "Tone",
    });
    const quick = push.data.quickAnswer as PushQuickAnswer;
    expect(quick.askFingerprint).toBe(askFingerprint(ask));

    // THE SEAM: what the lock screen sends, unchanged, through the owed
    // page's own answer service.
    const yes = quick.actions.find((a) => a.id === "yes")!;
    const answered = await answerSessionSlot({
      sessionId: quick.sessionId,
      userId: USER,
      expectedLabel: quick.expectedLabel,
      value: yes.value,
      askFingerprint: quick.askFingerprint,
    });
    expect(answered.status).toBe("answered");
  });

  const blockAct = async (sessionId: string, ask: Ask) => {
    h.pushes.length = 0;
    const r = await blockExpectedOutput({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      expectedLabel: "Tone",
      blockedReason: "action",
      why: "rotate the key",
      ask,
    } as Parameters<typeof blockExpectedOutput>[0]);
    expect(r.status).toBe("blocked");
    return (h.pushes[0]!.data as { quickAnswer: PushQuickAnswer }).quickAnswer;
  };

  it("an act ask's 'I did it' attests through the fingerprint-bound attest door", async () => {
    const sessionId = await seedSession("active");
    const quick = await blockAct(sessionId, { mode: "act", steps: ["Rotate"] });
    expect(quick).toMatchObject({ door: "attest", category: "ask-act" });
    const r = await attestSessionSlot({
      sessionId: quick.sessionId,
      userId: USER,
      expectedLabel: quick.expectedLabel,
      askFingerprint: quick.askFingerprint,
    });
    expect(r.status).toBe("attested");
  });

  it("a re-asked slot refuses the stale 'I did it' (ask_changed), attesting nothing", async () => {
    const sessionId = await seedSession("active");
    const quick = await blockAct(sessionId, { mode: "act", steps: ["Rotate"] });
    // The agent re-asks the same slot with a different act.
    await q(
      `update focus_sessions set expected_outputs = jsonb_set(expected_outputs, '{0,ask}', $1::jsonb) where id = $2`,
      [JSON.stringify({ mode: "act", steps: ["Revoke instead"] }), sessionId]
    );
    const r = await attestSessionSlot({
      sessionId,
      userId: USER,
      expectedLabel: quick.expectedLabel,
      askFingerprint: quick.askFingerprint,
    });
    expect(r.status).toBe("ask_changed");
    const row = await q<{ s: string }>(
      `select expected_outputs->0->>'status' as s from focus_sessions where id = $1`,
      [sessionId]
    );
    expect(row.rows[0]!.s).not.toBe("done");
  });
});
