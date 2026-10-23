/**
 * `synap_delete_entity` (decision B9b) through the REAL gate — what an agent's
 * delete actually becomes, not what the door asks.
 *
 * `entity.delete.pglite.test.ts` spies `checkPermissionOrPropose` to pin the
 * SEAM. This file mocks nothing on the governance path: the MCP handler → the
 * real hub caller (`createHubProtocolCaller`, as the MCP adapter builds it) →
 * hub `entities.deleteEntity` → `entities.delete` → `checkPermissionOrPropose`
 * → `resolveAgentGovernanceDecision` → the DESTRUCTIVE floor → the pending
 * proposal insert, on PGlite with every @synap/database table. Only delivery
 * side effects (event log, job queue, realtime, audit, undo fan-out) are stubbed.
 *
 * Rows, each ruling out a wrong outcome:
 *  - the agent's delete is a PENDING proposal stamped with THAT agent, and the
 *    row is untouched — rules out "the agent was lost on the way" and "filed,
 *    but anonymously";
 *  - CONTROL: the same door with no agent files the delete UNATTRIBUTED. The
 *    hub door writes as `source: "intelligence"`, so a call whose agent is lost
 *    is the anonymous AI principal: the gate floors it too (it never takes the
 *    person's path here). A lost agent therefore shows up as a NULL
 *    `agent_user_id`, which this row proves the door does not fill by default.
 *
 * What it does NOT cover, measured: the handler's own `agentUserId` spread is
 * not load-bearing on this path. Hub `deleteEntity` resolves the agent with
 * `actingAgentUserId(ctx, input.agentUserId)`, where the AUTHENTICATED
 * `ctx.agentUserId` (set by `createHubProtocolCaller`) wins over the field, so
 * dropping the spread alone changes no outcome (an equivalent mutant). The
 * attribution is pinned at the hub seam: `agentUserId` into `entities.delete`.
 * The request-scope agent (`runWithActingAgent`, entered by the MCP HTTP door)
 * is not entered here, so the hub-to-gate threading is what is tested.
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
        // PGlite is ONE connection: the proposal writer's transaction reads
        // the agent's focus and mints its receipt session through the global
        // `db` while the transaction holds that connection, which deadlocks
        // here (a pool gives production a second connection) and wedges every
        // later case. Run the body on the same handle; atomicity is not under
        // test (as proposal-review-session-gate.pglite.test.ts does).
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
    // The gate's own reads inside @synap/database (the proposal insert, the
    // pending-duplicate peek) import `db` from its client module, not from the
    // package entry: route that onto the same PGlite.
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
  // The event log appends over its own connection (no PGlite): a no-op here.
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
import { entityHandlers } from "./entity.js";
import { createHubProtocolCaller, type McpToolContext } from "./shared.js";

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
async function deletedAt(id: string): Promise<unknown> {
  const { rows } = await q<{ deleted_at: unknown }>(
    `select deleted_at from entities where id = $1`,
    [id]
  );
  expect(rows).toHaveLength(1); // a soft delete never removes the row
  return rows[0]!.deleted_at;
}

/** The handler as the MCP adapter calls it: both callers carry one agent. */
async function callDelete(agentUserId: string | undefined, entityId: string) {
  const scopes = ["mcp.read", "mcp.write"];
  const lensCaller = await createHubProtocolCaller(OWNER, scopes, agentUserId);
  const result = await entityHandlers.synap_delete_entity!({
    toolName: "synap_delete_entity",
    args: { entityId, reasoning: "I created it twice" },
    userId: OWNER,
    agentUserId,
    apiKeyScopes: scopes,
    lensCaller,
    caller: lensCaller,
  } as unknown as McpToolContext);
  expect(result.isError).not.toBe(true);
  const text = (result.content as Array<{ text?: string }>)
    .map((c) => c.text ?? "")
    .join("");
  return JSON.parse(text) as Record<string, unknown>;
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

describe("synap_delete_entity through the real gate (B9b)", () => {
  it("an agent's delete is a pending proposal stamped with that agent, and nothing is deleted", async () => {
    const id = await seedNote("Mistaken note");

    const payload = await callDelete(AGENT, id);

    expect(payload).toMatchObject({ entityId: id, status: "proposed" });
    expect(payload.landed).toMatch(/^Nothing is deleted yet/);
    const { rows } = await q<{
      status: string;
      agent_user_id: string | null;
      target_type: string;
      target_id: string;
      proposal_type: string;
    }>(
      `select status, agent_user_id, target_type, target_id, proposal_type
       from proposals where id = $1`,
      [payload.proposalId]
    );
    expect(rows).toEqual([
      {
        status: "pending",
        agent_user_id: AGENT,
        target_type: "entity",
        target_id: id,
        proposal_type: "delete",
      },
    ]);
    expect(await deletedAt(id)).toBeNull();
  });

  it("CONTROL: with no agent the same door files the delete unattributed (the agent column is not a default)", async () => {
    const id = await seedNote("The person's own note");

    const payload = await callDelete(undefined, id);

    expect(payload).toMatchObject({ entityId: id, status: "proposed" });
    const { rows } = await q<{ status: string; agent_user_id: string | null }>(
      `select status, agent_user_id from proposals where id = $1`,
      [payload.proposalId]
    );
    expect(rows).toEqual([{ status: "pending", agent_user_id: null }]);
    expect(await deletedAt(id)).toBeNull();
  });
});
