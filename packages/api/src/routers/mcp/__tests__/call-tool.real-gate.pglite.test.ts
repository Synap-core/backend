/**
 * `synap_call_tool` through the REAL governance gate: a write an agent key
 * dispatches lands as the same pending proposal its direct call files.
 *
 * Nothing on the governance path is mocked: `createMCPServer`'s tools/call
 * handler (the dispatcher's unwrap, the fence) → the REAL `tools.execute` →
 * the MCP adapter → `synap_delete_entity` → the hub `entities.deleteEntity`
 * → `checkPermissionOrPropose` → the DESTRUCTIVE floor → the proposal insert,
 * on PGlite with every @synap/database table (setup from
 * `handlers/entity.delete.real-gate.pglite.test.ts`). Only delivery side
 * effects (event log, job queue, realtime, audit) are stubbed.
 *
 * Rows:
 *  - the agent's dispatched delete is a PENDING proposal stamped with that
 *    agent, and the row is untouched: governance ran on the inner tool;
 *  - CONTROL: the direct call of the same tool files the same proposal, so the
 *    dispatcher adds and drops nothing on this path.
 *
 * Not covered: the request-scope agent (`runWithActingAgent`, entered by the
 * HTTP door) is not entered here; the agent reaches the gate through the
 * server's `agentUserId`, as in the direct-call real-gate test.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        const db = drizzle(client, { schema });
        // ONE PGlite connection: run a transaction body on the same handle
        // (see entity.delete.real-gate.pglite.test.ts).
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  const db = await h.init();
  return { ...actual, db, getDb: async () => db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createMCPServer } from "../index.js";
import { NO_UI_RENDERER } from "../ui-tools.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
let NOTE_PROFILE = "";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function seedNote(title: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties)
     values ($1, $2, null, $3, 'note', $4, '{}'::jsonb)`,
    [id, OWNER, NOTE_PROFILE, title]
  );
  return id;
}

type Handler = (req: unknown, extra: unknown) => Promise<unknown>;

/** The agent key's tools/call door (no key profile: every tool is listed). */
async function call(name: string, args: Record<string, unknown>) {
  const server = createMCPServer(
    undefined,
    OWNER,
    undefined,
    undefined,
    AGENT,
    ["mcp.read", "mcp.write"],
    "hub_inbound",
    null,
    undefined,
    "full",
    NO_UI_RENDERER,
    { keyType: "hub_inbound", linkedUserId: OWNER, isAgent: true, grant: null }
  ) as unknown as { _requestHandlers: Map<string, Handler> };
  const handler = server._requestHandlers.get("tools/call")!;
  const result = (await handler(
    { method: "tools/call", params: { name, arguments: args } },
    { signal: new AbortController().signal, sendNotification: vi.fn() }
  )) as { isError?: boolean; content: Array<{ text?: string }> };
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse(result.content.map((c) => c.text ?? "").join("")) as {
    status?: string;
    proposalId?: string;
  };
}

async function proposalOf(id: string) {
  const { rows } = await q<{
    status: string;
    agent_user_id: string | null;
    target_id: string;
    proposal_type: string;
  }>(
    `select status, agent_user_id, target_id, proposal_type from proposals where id = $1`,
    [id]
  );
  return rows;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    OWNER,
    "owner@x.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id, agent_type)
     values ($1, 'agent@x.test', 'agent', $2, 'claude-code')`,
    [AGENT, OWNER]
  );
  const { rows } = await q<{ id: string }>(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values (gen_random_uuid(),'note','Note','kind','system','pod',null,true,'{}'::jsonb) returning id`
  );
  NOTE_PROFILE = rows[0]!.id;
}, 120_000);

describe("synap_call_tool through the real gate", () => {
  it("an agent's dispatched delete is a pending proposal stamped with that agent, and nothing is deleted", async () => {
    const id = await seedNote("Dispatched");
    const payload = await call("synap_call_tool", {
      tool: "synap_delete_entity",
      arguments: { entityId: id, reasoning: "made twice" },
    });
    expect(payload.status).toBe("proposed");
    expect(await proposalOf(payload.proposalId!)).toEqual([
      {
        status: "pending",
        agent_user_id: AGENT,
        target_id: id,
        proposal_type: "delete",
      },
    ]);
    const { rows } = await q<{ deleted_at: unknown }>(
      `select deleted_at from entities where id = $1`,
      [id]
    );
    expect(rows).toEqual([{ deleted_at: null }]);
  });

  it("CONTROL: the direct call of the same tool files the same proposal", async () => {
    const id = await seedNote("Direct");
    const payload = await call("synap_delete_entity", {
      entityId: id,
      reasoning: "made twice",
    });
    expect(payload.status).toBe("proposed");
    expect(await proposalOf(payload.proposalId!)).toEqual([
      {
        status: "pending",
        agent_user_id: AGENT,
        target_id: id,
        proposal_type: "delete",
      },
    ]);
  });
});
