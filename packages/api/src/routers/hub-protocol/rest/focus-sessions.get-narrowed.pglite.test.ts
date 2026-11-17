/**
 * GET /focus-sessions/:id for a key pinned to spaces (a pod app): the row, read
 * through the key's grant, never the packet it cannot read.
 *
 * The door used to be an aggregate read (`READS` of twelve subjects), which no
 * pinned grant ever passes: every pod app was refused GRANT_DOOR_UNSUPPORTED on
 * a session the list door already gave it. The fence now admits a key that
 * reads `session`; the ROUTE floors the row with `sessionReadableWhere` (the
 * list door's grant clause) and adds the packet only when
 * `sessionPacketReadable`.
 *
 * Through the REAL route on PGlite, the grant set as the auth middleware sets
 * it. Rows rule out: a floor that ignores the grant (the other-space row), a
 * packet served to a key that cannot read it (the withheld row), and a
 * narrowing that also strips the packet from a person (the control row).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

// The whole packet's readers are not under test here: a sentinel says whether
// the route asked for them at all. The SHAPE a narrowed key reads beside the
// row (`projectSessionShape`) runs for real.
vi.mock(
  "../../../services/focus-sessions/continuation-packet.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    projectContinuationPacket: async () => ({
      rerun: null,
      evaluation: { status: "unavailable" },
      sentinel: "packet",
    }),
  })
);
vi.mock(
  "../../../services/focus-sessions/session-outputs.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    readSessionOutcomesSection: async () => ({ status: "unavailable" }),
  })
);

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

const OWNER = randomUUID();
const WS_CRM = randomUUID();
const WS_OTHER = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

async function seedSession(
  workspaceId: string,
  opts: { title?: string; outputs?: unknown[] } = {}
): Promise<string> {
  const id = randomUUID();
  await h.client!.query(
    `insert into focus_sessions (id, user_id, workspace_id, title, goal, status, started_at, created_at, updated_at, metadata, expected_outputs, stage_history) values ($1, $2, $3, $4, 'g', 'active', now(), now(), now(), '{"stage":{"index":1,"of":4}}'::jsonb, $5::jsonb, '[{"key":"build","enteredAt":"2026-11-17T10:00:00.000Z"}]'::jsonb)`,
    [
      id,
      OWNER,
      workspaceId,
      opts.title ?? "Build a prospect list",
      JSON.stringify(opts.outputs ?? []),
    ]
  );
  return id;
}

/** `child --spawned_from--> parent`, the edge lineage is read from. */
async function spawn(child: string, parent: string): Promise<void> {
  await h.client!.query(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at) values ($1, 'session', $2, 'session', $3, 'spawned_from', '{}'::jsonb, now())`,
    [randomUUID(), child, parent]
  );
}

/** One runner of `sessionId`, with the local details a person's client needs. */
async function runner(sessionId: string): Promise<void> {
  await h.client!.query(
    `insert into session_runners (session_id, client_key, user_id, harness, conversation_id, cwd, process_key, process_host, state, model, first_seen_at, last_seen_at) values ($1, 'ck', $2, 'claude-code', 'conv-secret', '/Users/someone/private-repo', 'host:1:2', 'devbox', 'busy', 'opus', now(), now())`,
    [sessionId, OWNER]
  );
}

const APP_GRANT = {
  scopes: [
    {
      permissions: ["session.read", "entity.person.read"],
      workspaceIds: [WS_CRM],
    },
  ],
  clientId: null,
};

function get(id: string, grant?: unknown) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  const send = () => app.request(`/focus-sessions/${id}`);
  return grant ? runWithGrant(grant as never, () => send()) : send();
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
});

/** The app's grant, plus the person's agents (a PERSON door: any pin). */
const APP_WITH_AGENTS = {
  scopes: [
    {
      permissions: ["session.read", "agent.read"],
      workspaceIds: [WS_CRM],
    },
  ],
  clientId: null,
};

const PR_URL = "https://github.com/Synap-core/backend/pull/7";

describe("GET /focus-sessions/:id — a narrowed key reads the session's shape under its grant (D1)", () => {
  it("lists only the neighbour sessions its grant reads, and the PRs the row recorded", async () => {
    const id = await seedSession(WS_CRM, {
      outputs: [
        {
          key: "pr-backend-7",
          label: "backend#7",
          kind: "pull_request",
          ref: { url: PR_URL },
        },
      ],
    });
    const inGrant = await seedSession(WS_CRM, { title: "Child in CRM" });
    const outOfGrant = await seedSession(WS_OTHER, { title: "Child elsewhere" });
    await spawn(inGrant, id);
    await spawn(outOfGrant, id);
    await runner(id);

    const res = await get(id, APP_GRANT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.packet).toMatchObject({ status: "withheld" });
    // The stage history is the row's own column.
    expect(body.stageHistory).toEqual([
      { key: "build", enteredAt: "2026-11-17T10:00:00.000Z" },
    ]);
    // Children: the grant's one, counted alone — the other is neither listed
    // nor counted.
    expect(body.children).toMatchObject({ status: "ok", total: 1 });
    expect(body.children.items.map((c: { id: string }) => c.id)).toEqual([
      inGrant,
    ]);
    expect(JSON.stringify(body)).not.toContain(outOfGrant);
    expect(JSON.stringify(body)).not.toContain("Child elsewhere");
    expect(body.parent).toEqual({ status: "ok", session: null });
    // The PR the row recorded, without the recorded PR facts.
    expect(body.workUnits).toMatchObject({ status: "ok", total: 1 });
    expect(body.workUnits.items[0]).toMatchObject({ url: PR_URL });
    expect(body.workUnits.items[0].prState).toBeUndefined();
    // No `agent.read`: who works it is withheld, said so.
    expect(body.runners).toMatchObject({ status: "withheld" });
    expect(JSON.stringify(body)).not.toContain("conv-secret");
  });

  it("a child reads its parent when the grant reads it, never one it does not", async () => {
    const parent = await seedSession(WS_CRM, { title: "Wave root" });
    const child = await seedSession(WS_CRM);
    await spawn(child, parent);
    const body = (await (await get(child, APP_GRANT)).json()) as Record<
      string,
      any
    >;
    expect(body.parent).toMatchObject({
      status: "ok",
      session: { id: parent, title: "Wave root" },
    });

    const hiddenParent = await seedSession(WS_OTHER, { title: "Hidden root" });
    const orphan = await seedSession(WS_CRM);
    await spawn(orphan, hiddenParent);
    const body2 = (await (await get(orphan, APP_GRANT)).json()) as Record<
      string,
      any
    >;
    expect(body2.parent).toEqual({ status: "ok", session: null });
    expect(JSON.stringify(body2)).not.toContain("Hidden root");
  });

  it("with agent.read: the runners, without the local details", async () => {
    const id = await seedSession(WS_CRM);
    await runner(id);
    const body = (await (await get(id, APP_WITH_AGENTS)).json()) as Record<
      string,
      any
    >;
    expect(body.runners).toMatchObject({ status: "ok", total: 1 });
    expect(body.runners.items[0]).toMatchObject({
      harness: "claude-code",
      processHost: "devbox",
      state: "busy",
      model: "opus",
    });
    for (const local of ["cwd", "conversationId", "processId", "resume"]) {
      expect(body.runners.items[0]).not.toHaveProperty(local);
    }
    expect(JSON.stringify(body)).not.toContain("private-repo");
  });

  it("CONTROL: the person gets the packet, never the narrowed shape beside it", async () => {
    const id = await seedSession(WS_CRM);
    const body = (await (await get(id)).json()) as Record<string, unknown>;
    expect(body.continuation).toMatchObject({ sentinel: "packet" });
    expect(body.children).toBeUndefined();
    expect(body.runners).toBeUndefined();
  });
});

describe("GET /focus-sessions/:id — a pinned key reads the row, not the packet", () => {
  it("an app pinned to the CRM space reads a CRM session: the row, packet withheld", async () => {
    const id = await seedSession(WS_CRM);
    const res = await get(id, APP_GRANT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(id);
    expect(body.title).toBe("Build a prospect list");
    expect(body.metadata).toEqual({ stage: { index: 1, of: 4 } });
    expect(body.packet).toMatchObject({ status: "withheld" });
    expect(body.continuation).toBeUndefined();
    expect(body.outcomes).toBeUndefined();
  });

  it("the same app cannot read a session in a space it was not given (404)", async () => {
    const id = await seedSession(WS_OTHER);
    const res = await get(id, APP_GRANT);
    expect(res.status).toBe(404);
  });

  it("CONTROL: the person (no key grant) still gets the whole packet", async () => {
    const id = await seedSession(WS_OTHER);
    const res = await get(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.packet).toBeUndefined();
    expect(body.continuation).toMatchObject({ sentinel: "packet" });
  });
});
