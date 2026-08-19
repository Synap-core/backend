/**
 * THREADS MESSAGE DOORS — identity + channel-write-floor regression proofs.
 *
 * Three defects are locked closed here, all on the two message-append doors of
 * `rest/threads.ts`:
 *
 *   1. `POST /threads/:id/messages.batch` inserted `userId: m.userId` STRAIGHT
 *      from the request body — no `resolveActingContext` — while its
 *      single-message sibling was already hardened. That is a
 *      governed-agent-write → ungoverned-operator-write IDOR, and the same
 *      unverified id also reached `emitMessageEvent` and `triggerAutoRespond`.
 *   2. NEITHER door checked that the caller may write to `threadId`: any key
 *      holding `hub-protocol.write` plus a known channel UUID could append to
 *      that channel.
 *   3. The batch door wrote NO attribution, so one channel mixed attributed
 *      (single-post) and unattributed (batch) agent rows.
 *
 * WHY A FAKE `db` AND NOT LIVE PG: these are HANDLER-level proofs — they must
 * observe what the route *decides* (403 before any insert; which `userId` and
 * which attribution columns reach the insert). Postgres is down in CI-less dev
 * sessions, and a self-skipping live suite proves nothing when it skips. Only
 * `db` and `emitMessageEvent` are replaced — `importOriginal` keeps every other
 * export real, so a NEW source import cannot silently kill the mock (the
 * total-`vi.mock` failure mode).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "0aaaaaaa-0000-4000-8000-000000000001";
const ATTACKER = "0bbbbbbb-0000-4000-8000-000000000002";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const THREAD = "0ddddddd-0000-4000-8000-000000000004";

/** Everything the fake `db` observed / should answer with. */
const state = {
  /** Rows the channel write-floor lookup resolves to ([] = caller cannot reach). */
  channelRows: [] as Array<{ id: string }>,
  /** Every row handed to `insert(messages).values(...)`. */
  inserted: [] as Record<string, unknown>[],
};

function selectChain(): any {
  const chain: any = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(state.channelRows),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(state.channelRows).then(res, rej),
  };
  return chain;
}

const insertChain = () => ({
  values: async (row: Record<string, unknown>) => {
    state.inserted.push(row);
  },
});

const fakeDb: any = {
  select: () => selectChain(),
  insert: () => insertChain(),
  transaction: async (cb: (tx: any) => Promise<unknown>) =>
    cb({ insert: () => insertChain() }),
  query: {},
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: fakeDb, emitMessageEvent: vi.fn(async () => {}) };
});

const triggerAutoRespond = vi.fn(async () => {});
vi.mock("../../../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: (...args: unknown[]) =>
    triggerAutoRespond(...(args as [])),
}));

const { registerThreadsRoutes } = await import("../threads.js");

/** Hub REST app with the auth middleware's context variables pre-set. */
function makeApp(vars: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v !== undefined) c.set(k as never, v as never);
    }
    await next();
  });
  registerThreadsRoutes(app as never);
  return app;
}

const WRITE_SCOPE = ["hub-protocol.write"];

const post = (app: OpenAPIHono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const batchBody = (userId: string) => ({
  messages: [{ role: "user" as const, content: "hello", userId }],
});

const singleBody = (userId: string) => ({
  role: "user" as const,
  content: "hello",
  userId,
});

beforeEach(() => {
  state.channelRows = [];
  state.inserted = [];
  triggerAutoRespond.mockClear();
});

describe("batch door — acting identity comes from auth, never the body", () => {
  it("rejects an UNAUTHENTICATED batch that names a victim as the author", async () => {
    // The pre-fix door inserted `userId: m.userId` with no identity check at
    // all: a scope-holding, user-less caller could author rows AS someone else.
    state.channelRows = [{ id: THREAD }];
    const app = makeApp({ scopes: WRITE_SCOPE });

    const res = await post(
      app,
      `/threads/${THREAD}/messages.batch`,
      batchBody(ATTACKER)
    );

    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("rejects a session-authenticated batch whose item claims ANOTHER userId", async () => {
    state.channelRows = [{ id: THREAD }];
    // No `apiKeyId` → not a delegating service key, so the body may only ever
    // name the authenticated user (same rule as the single-message door).
    const app = makeApp({ scopes: WRITE_SCOPE, userId: OWNER });

    const res = await post(
      app,
      `/threads/${THREAD}/messages.batch`,
      batchBody(ATTACKER)
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "userId does not match the authenticated session",
    });
    expect(state.inserted).toHaveLength(0);
  });

  it("stamps the VERIFIED acting id on the row and on the autoRespond dispatch", async () => {
    state.channelRows = [{ id: THREAD }];
    const app = makeApp({ scopes: WRITE_SCOPE, userId: OWNER });

    const res = await post(app, `/threads/${THREAD}/messages.batch`, {
      ...batchBody(OWNER),
      autoRespond: true,
    });

    expect(res.status).toBe(200);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0].userId).toBe(OWNER);
    expect(triggerAutoRespond).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUserId: OWNER })
    );
  });
});

describe("channel write floor — both doors", () => {
  it("batch: a caller who cannot reach the channel is refused BEFORE any insert", async () => {
    state.channelRows = []; // visibility predicate matches nothing for this caller
    const app = makeApp({ scopes: WRITE_SCOPE, userId: ATTACKER });

    const res = await post(
      app,
      `/threads/${THREAD}/messages.batch`,
      batchBody(ATTACKER)
    );

    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
    expect(triggerAutoRespond).not.toHaveBeenCalled();
  });

  it("single: a caller who cannot reach the channel is refused BEFORE any insert", async () => {
    state.channelRows = [];
    const app = makeApp({ scopes: WRITE_SCOPE, userId: ATTACKER });

    const res = await post(
      app,
      `/threads/${THREAD}/messages`,
      singleBody(ATTACKER)
    );

    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("a non-UUID threadId is refused, never bound into a uuid comparison", async () => {
    state.channelRows = [{ id: THREAD }]; // even if the lookup would answer
    const app = makeApp({ scopes: WRITE_SCOPE, userId: OWNER });

    const res = await post(
      app,
      "/threads/not-a-uuid/messages",
      singleBody(OWNER)
    );

    expect(res.status).toBe(403);
    expect(state.inserted).toHaveLength(0);
  });

  it("a reachable channel lets both doors through", async () => {
    state.channelRows = [{ id: THREAD }];
    const app = makeApp({ scopes: WRITE_SCOPE, userId: OWNER });

    expect(
      (await post(app, `/threads/${THREAD}/messages`, singleBody(OWNER))).status
    ).toBe(200);
    expect(
      (await post(app, `/threads/${THREAD}/messages.batch`, batchBody(OWNER)))
        .status
    ).toBe(200);
    expect(state.inserted).toHaveLength(2);
  });
});

describe("batch door — agent attribution matches the single-message door", () => {
  it("writes authorType + routedTeammateId + routedSource from the auth context", async () => {
    state.channelRows = [{ id: THREAD }];
    const app = makeApp({
      scopes: WRITE_SCOPE,
      userId: OWNER,
      apiKeyId: "key-1",
      agentUserId: AGENT,
    });

    const res = await post(
      app,
      `/threads/${THREAD}/messages.batch`,
      batchBody(OWNER)
    );

    expect(res.status).toBe(200);
    const row = state.inserted[0];
    expect(row.authorType).toBe("ai_agent");
    expect(row.routedTeammateId).toBe(AGENT);
    // `routedSource` MUST accompany the teammate id or the UI resolver drops
    // the attribution entirely.
    expect(row.routedSource).toBe("direct");
    // ⚠️ `sessionId` is deliberately NOT written: `messages.sessionId` FKs to
    // `sessions` while `X-Session-Id` carries a FOCUS session id — writing one
    // into the other violates the FK and 500s the post.
    expect(row.sessionId).toBeUndefined();
  });

  it("a human (no agent in the auth context) is attributed HUMAN, unrouted", async () => {
    state.channelRows = [{ id: THREAD }];
    const app = makeApp({ scopes: WRITE_SCOPE, userId: OWNER });

    await post(app, `/threads/${THREAD}/messages.batch`, batchBody(OWNER));

    const row = state.inserted[0];
    expect(row.authorType).toBe("human");
    expect(row.routedTeammateId).toBeUndefined();
    expect(row.routedSource).toBeUndefined();
  });
});
