/**
 * `createFocusSession` refuses a SUBJECT the caller cannot see, for every door.
 *
 * A session's `subjectEntityId` is the thing the work is ABOUT: the room
 * resolves its live title by bare id. The tRPC and Hub start doors used to
 * floor it themselves, and MCP `synap_start_session` forwarded it unchecked, so
 * an agent could anchor a session on any entity id in the pod and read its
 * title back (a read oracle). The floor now lives in the ONE start door every
 * caller passes, through the same predicate an output's ref goes through
 * (`isOutputRefVisible`) — real here, on real rows.
 *
 * Driven through the REAL doors: MCP `synap_start_session`, tRPC
 * `focusSessions.create`, Hub `POST /focus-sessions`, and the service itself
 * (the shape of the internal callers: plan sessions, the deferred-start replay,
 * the decision-ask reactor).
 *
 * Real: the three doors, `createFocusSession`, `isOutputRefVisible` →
 * `scopedDb` on PGlite with every @synap/database table. Stubbed: governance
 * (granted), the session room mint, realtime, project placement, spawn links.
 *
 * NOT covered here: "Give to agent" (`giveCaptureToAgent`) passes no subject
 * on main, so it cannot reach this floor; its subject arrives with door 2 and
 * is tested there.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, { schema });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
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

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";
import { isOutputRefVisible } from "../assert-output-ref-visible.js";
import { focusSessionsRouter } from "../../../routers/focus-sessions.js";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import type {
  HubHono,
  HubVariables,
} from "../../../routers/hub-protocol/rest/_shared.js";

const { sessionHandlers } =
  await import("../../../routers/mcp/handlers/session.js");

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const THEIR_SPACE = "44444444-4444-4444-8444-444444444444";
/** A space the caller belongs to: the Hub door refuses a start with no scope. */
const MY_SPACE = "77777777-7777-4777-8777-777777777777";
const MY_ENTITY = "55555555-5555-4555-8555-555555555555";
const THEIR_ENTITY = "66666666-6666-4666-8666-666666666666";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

/** Every stored session of this goal, with its subject. */
const stored = async (goal: string) =>
  (
    await h.client!.query<{ subject_entity_id: string | null }>(
      `select subject_entity_id from focus_sessions where goal = $1`,
      [goal]
    )
  ).rows;

function hub(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const hubStart = (body: Record<string, unknown>) =>
  hub().request("/focus-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: USER, workspaceId: MY_SPACE, ...body }),
  });

// An agent start must declare what done means (backend#514: NO_CRITERIA
// otherwise), so every MCP start here carries one criterion. The subject floor
// is then the only thing that can refuse it.
const mcpStart = (args: Record<string, unknown>) =>
  sessionHandlers.synap_start_session!({
    toolName: "synap_start_session",
    args: {
      matchTemplate: false,
      forceCreate: true,
      criteria: [
        { key: "done", statement: "The test ran", check: { kind: "human" } },
      ],
      ...args,
    },
    userId: USER,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);

const trpc = () =>
  focusSessionsRouter.createCaller({
    userId: USER,
    authenticated: true,
  } as never);

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'r@x.test', 'Raycast', 'agent'),
      ($3, 's@x.test', 'Stranger', 'human')`,
    [USER, AGENT, STRANGER]
  );
  // A space only the stranger belongs to, and an entity filed in it.
  await h.client!.query(
    `insert into workspaces (id, name, owner_id) values ($1, 'Theirs', $2)`,
    [THEIR_SPACE, STRANGER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), THEIR_SPACE, STRANGER]
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id) values ($1, 'Mine', $2)`,
    [MY_SPACE, USER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), MY_SPACE, USER]
  );
  await h.client!.query(
    `insert into entities (id, user_id, workspace_id, type, title) values
      ($1, $2, null, 'issue', 'My issue'),
      ($3, $4, $5, 'issue', 'Their secret issue')`,
    [MY_ENTITY, USER, THEIR_ENTITY, STRANGER, THEIR_SPACE]
  );
}, 120_000);

describe("fixture — the floor sees what the cases claim", () => {
  it("my entity is visible to me; the stranger's is not", async () => {
    expect(
      await isOutputRefVisible({
        userId: USER,
        kind: "entity",
        refId: MY_ENTITY,
      })
    ).toBe(true);
    expect(
      await isOutputRefVisible({
        userId: USER,
        kind: "entity",
        refId: THEIR_ENTITY,
      })
    ).toBe(false);
    // The stranger CAN see it: the row is real, only the caller is wrong.
    expect(
      await isOutputRefVisible({
        userId: STRANGER,
        kind: "entity",
        refId: THEIR_ENTITY,
      })
    ).toBe(true);
  });
});

describe("createFocusSession — the subject floor, every door", () => {
  it("MCP synap_start_session: someone else's entity is NOT_FOUND, nothing stored", async () => {
    const goal = `Agent peek ${randomUUID()}`;
    await expect(
      mcpStart({ goal, subjectEntityId: THEIR_ENTITY })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await stored(goal)).toEqual([]);
  });

  it("tRPC focusSessions.create: someone else's entity is NOT_FOUND, nothing stored", async () => {
    const goal = `Person peek ${randomUUID()}`;
    await expect(
      trpc().create({ goal, subjectEntityId: THEIR_ENTITY })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await stored(goal)).toEqual([]);
  });

  it("Hub POST /focus-sessions: someone else's entity is a 404, nothing stored", async () => {
    const goal = `Hub peek ${randomUUID()}`;
    const res = await hubStart({ goal, subjectEntityId: THEIR_ENTITY });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: `No entity ${THEIR_ENTITY} you can access`,
    });
    expect(await stored(goal)).toEqual([]);
  });

  it("the service (internal callers' shape): someone else's entity is NOT_FOUND", async () => {
    const goal = `Internal peek ${randomUUID()}`;
    await expect(
      createFocusSession({
        userId: USER,
        goal,
        subjectEntityId: THEIR_ENTITY,
        matchTemplate: false,
        forceCreate: true,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await stored(goal)).toEqual([]);
  });

  it("MCP: the caller's own entity is stored as the subject", async () => {
    const goal = `Agent mine ${randomUUID()}`;
    const res = await mcpStart({ goal, subjectEntityId: MY_ENTITY });
    const body = JSON.parse(
      (res.content as Array<{ text: string }>)[0]!.text
    ) as { status?: string };
    expect(body.status).toBe("created");
    expect(await stored(goal)).toEqual([{ subject_entity_id: MY_ENTITY }]);
  });

  it("Hub: the caller's own entity is stored as the subject", async () => {
    const goal = `Hub mine ${randomUUID()}`;
    const res = await hubStart({ goal, subjectEntityId: MY_ENTITY });
    expect(res.status).toBe(200);
    expect(await stored(goal)).toEqual([{ subject_entity_id: MY_ENTITY }]);
  });

  it("CONTROL — no subject named still creates, subject-less", async () => {
    const goal = `Subjectless ${randomUUID()}`;
    const res = await createFocusSession({
      userId: USER,
      goal,
      matchTemplate: false,
      forceCreate: true,
    });
    expect(res.status).toBe("created");
    expect(await stored(goal)).toEqual([{ subject_entity_id: null }]);
  });
});
