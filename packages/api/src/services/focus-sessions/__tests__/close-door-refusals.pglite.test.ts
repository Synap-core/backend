/**
 * The close doors refuse ALIKE — driven through the real Hub doors and the
 * real MCP handler, read back out of PGlite.
 *
 * Each test names what it rules out:
 *   - a Hub PATCH to a terminal status answering the open-questions refusal
 *     with a bare `{error}` while `/complete` hands the agent the list (the
 *     two doors of one close, two answers);
 *   - the MCP close reading a disposition that is neither `withdrawn` nor
 *     `keep_as_owed` as "keep" (a typo kept a question owed past its session).
 *
 * Stubbed, and why: governance (`checkPermissionOrPropose`: granted — the
 * membrane is not under test, the refusal comes BEFORE it), and the same
 * transport seams as `relay-answer.pglite.test.ts` (sockets, Expo, the event
 * history row, channel visibility).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
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
      schema: {
        focusSessions: actual.focusSessions as never,
        notifications: actual.notifications as never,
        users: actual.users as never,
        channels: actual.channels as never,
        channelMembers: actual.channelMembers as never,
        messages: actual.messages as never,
        sessionEvaluations: actual.sessionEvaluations as never,
        playbookRuns: actual.playbookRuns as never,
        entities: actual.entities as never,
      },
    }),
    eventRepository: { append: async () => undefined },
    emitMessageEvent: async () => undefined,
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  settleParentAutomationRunFromChild: async () => undefined,
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: async () => ({ granted: true }),
}));
vi.mock("../../../notifications/expo-push.js", () => ({
  sendExpoPush: async () => ({ sent: 1, revoked: 0, failed: 0 }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { allSchemaTables } from "../../../__tests__/pglite-ddl.js";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "44444444-4444-4444-8444-444444444444";

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

beforeAll(async () => {
  for (const t of allSchemaTables()) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, email, name, timezone, user_type, agent_type) values
      ($1, 'a@example.test', 'Antoine', 'UTC', 'human', null),
      ($2, 'c@example.test', 'Claude Code', 'UTC', 'agent', 'claude-code')`,
    [OWNER, AGENT]
  );
}, 120_000);
afterAll(async () => h.client?.close());

/** An open session with the agent's open question in its room. */
async function seedWithQuestion(): Promise<{
  sessionId: string;
  questionId: string;
}> {
  const channelId = randomUUID();
  await q(
    `insert into channels (id, user_id, channel_type, title, created_at, updated_at) values ($1, $2, 'group', 'Billing', now(), now())`,
    [channelId, OWNER]
  );
  const sessionId = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, title, status, expected_outputs, agent_ids, metadata, criteria, channel_id, created_at, updated_at, started_at)
     values ($1, $2, 'Billing', 'Billing', 'active', '[]'::jsonb, $3, '{}'::jsonb, '[]'::jsonb, $4, now(), now(), now())`,
    [sessionId, OWNER, [AGENT], channelId]
  );
  const questionId = randomUUID();
  await q(
    `insert into messages (id, channel_id, role, author_type, content, user_id, hash, routed_teammate_id, metadata)
     values ($1, $2, 'assistant', 'ai_agent', 'Which Stripe account?', $3, 'h', $4, $5::jsonb)`,
    [
      questionId,
      channelId,
      OWNER,
      AGENT,
      JSON.stringify({ roomPost: { kind: "question" } }),
    ]
  );
  return { sessionId, questionId };
}

const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(
      `select status from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!.status;

function app() {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("userId" as never, OWNER as never);
    c.set(
      "scopes" as never,
      ["hub-protocol.write", "hub-protocol.read"] as never
    );
    c.set("agentUserId" as never, AGENT as never);
    await next();
  });
  registerFocusSessionsRoutes(a as never);
  return a;
}
const call = (method: "POST" | "PATCH", path: string, body: unknown) =>
  app().request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the close doors refuse an agent's close over its open question alike", () => {
  it("Hub PATCH to a terminal status answers /complete's refusal, list and all", async () => {
    const a = await seedWithQuestion();
    const viaComplete = await call(
      "POST",
      `/focus-sessions/${a.sessionId}/complete`,
      {}
    );
    const b = await seedWithQuestion();
    const viaPatch = await call("PATCH", `/focus-sessions/${b.sessionId}`, {
      status: "closed",
    });

    expect(viaComplete.status).toBe(409);
    expect(viaPatch.status).toBe(409);
    const completeBody = (await viaComplete.json()) as Record<string, unknown>;
    const patchBody = (await viaPatch.json()) as Record<string, unknown>;
    expect(patchBody).toMatchObject({
      status: "refused",
      reasonCode: "OPEN_QUESTIONS",
      openQuestions: [{ messageId: b.questionId }],
    });
    expect(Object.keys(patchBody).sort()).toEqual(
      Object.keys(completeBody).sort()
    );
    expect(await statusOf(a.sessionId)).toBe("active");
    expect(await statusOf(b.sessionId)).toBe("active");
  });

  it("the MCP close refuses a disposition that is neither withdrawn nor keep_as_owed", async () => {
    const { sessionHandlers } =
      await import("../../../routers/mcp/handlers/session.js");
    const s = await seedWithQuestion();
    const res = await sessionHandlers.synap_complete_session!({
      toolName: "synap_complete_session",
      args: {
        sessionId: s.sessionId,
        questionDispositions: [
          { messageId: s.questionId, disposition: "keep" },
        ],
      },
      userId: OWNER,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.read", "mcp.write"],
    } as never);
    const body = JSON.parse(
      (res.content as Array<{ text: string }>)[0]!.text
    ) as Record<string, unknown>;
    expect(body.error).toMatch(/questionDispositions/);
    expect(await statusOf(s.sessionId)).toBe("active");
    const owed = (
      await q<{ expected_outputs: unknown[] }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [s.sessionId]
      )
    ).rows[0]!.expected_outputs;
    expect(owed).toEqual([]);
  });
});
