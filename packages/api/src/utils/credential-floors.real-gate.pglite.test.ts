/**
 * An agent's `tool.create` and `workspace.adopt` are ALWAYS proposals (founder,
 * 21 Nov 2026, findings cdc41c35 and 61ed6cb5), whatever rule or preset says,
 * like an install since #1200.
 *
 * Each write is approved by an executor that declares `widensCredential`
 * (a tool can carry a `credentialRef`; adopting a template installs its
 * capabilities): approving it is the person's act after a fresh sign-in. A
 * broad rule that EXECUTED it at the gate skipped both. Before the fix the
 * CLI `normal` preset (an exact `tool.create` auto rule) and a `*` auto rule
 * both executed them for an agent.
 *
 * Driven through the REAL `checkPermissionOrPropose` on PGlite with every
 * @synap/database table: `tools.create` end to end (the gate, then the
 * insert it skips when it proposes), and `workspace.adopt` at the gate with
 * the exact arguments `POST /pod/adopt` passes (that route also resolves a
 * catalog template, which is not what is under test). The acting agent is
 * entered as the key-auth doors enter it (`runWithActingAgent`). Only
 * delivery side effects (event log, job queue, realtime, audit) are stubbed.
 *
 * Rows, each ruling out a wrong outcome:
 *  - an agent with an exact `tool.create` auto rule and a `*` auto rule asks
 *    for a tool: proposed, no tool row;
 *  - the same agent adopts a template into a space: proposed;
 *  - CONTROL: the same `*` rule still executes a widenable write
 *    (`workspace.declare_source`) for that agent: the rule is live;
 *  - CONTROL: the person, signed in (no agent), creates a tool directly.
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
        // PGlite is ONE connection: run a transaction body on the same handle
        // (atomicity is not under test).
        (db as unknown as { transaction: unknown }).transaction = async (
          fn: (tx: unknown) => Promise<unknown>
        ) => fn(db);
        state.db = db;
      }
      return state.db;
    },
    // The gate's reads inside @synap/database import `db` from its client
    // module, not from the package entry: route that onto the same PGlite.
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

vi.mock("../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../database/src/client-pg.js", () => h.clientPgModule());
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
vi.mock("./chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("./audit-log.js", () => ({
  auditLog: vi.fn(async () => null),
}));
vi.mock("./domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("./split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithActingAgent } from "@synap/database";
import { checkPermissionOrPropose } from "./permission-check.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();

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

const toolsNamed = async (name: string) =>
  (await q(`select id from tools where name = $1`, [name])).rows;

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
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1, $2, 'owner')`,
    [randomUUID(), OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Alpha', $2, '{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $2, $5, 'editor')`,
    [randomUUID(), WS, OWNER, randomUUID(), AGENT]
  );
  // The CLI `normal` preset's mirrored row, and a global "always approve".
  for (const pattern of ["tool.create", "*"]) {
    await q(
      `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by, created_at)
       values (gen_random_uuid(), 'agent', $1, 'pod', 'action', $2, 'auto', $3, now())`,
      [AGENT, pattern, OWNER]
    );
  }
}, 120_000);

async function toolsCaller() {
  const { toolsRouter } = await import("../routers/tools.js");
  return toolsRouter.createCaller({
    db: await h.init(),
    authenticated: true,
    userId: OWNER,
    workspaceId: null,
  } as never);
}

describe("an agent's credential writes are proposals whatever rule says (cdc41c35, 61ed6cb5)", () => {
  it("SECURITY: an agent with a `tool.create` and a `*` auto rule asks for a tool: proposed, no tool is made", async () => {
    const caller = await toolsCaller();
    const out = await runWithActingAgent(AGENT, () =>
      caller.create({
        name: "agent-made-tool",
        kind: "api",
        credentialRef: "vault://some-key",
        workspaceId: WS,
        agentUserId: AGENT,
      })
    );

    expect(out).toMatchObject({
      status: "proposed",
      tool: null,
      proposalId: expect.any(String),
    });
    expect(await toolsNamed("agent-made-tool")).toEqual([]);
    const [row] = (
      await q<{ status: string; agent_user_id: string | null }>(
        `select status, agent_user_id from proposals where id = $1`,
        [out.proposalId]
      )
    ).rows;
    expect(row).toMatchObject({ status: "pending", agent_user_id: AGENT });
  });

  it("SECURITY: the same agent adopts a template into a space: proposed (the arguments POST /pod/adopt passes)", async () => {
    const perm = await runWithActingAgent(AGENT, () =>
      checkPermissionOrPropose({
        userId: OWNER,
        agentUserId: AGENT,
        workspaceId: WS,
        subjectType: "workspace",
        action: "adopt",
        data: {
          workspaceId: WS,
          templateSlug: "sales-os",
          packageVersion: null,
        },
      })
    );

    expect(perm).toMatchObject({ proposalId: expect.any(String) });
    expect("granted" in perm && perm.granted).toBe(false);
  });

  it("CONTROL: the same `*` rule still executes a widenable write for that agent", async () => {
    const perm = await runWithActingAgent(AGENT, () =>
      checkPermissionOrPropose({
        userId: OWNER,
        agentUserId: AGENT,
        workspaceId: WS,
        subjectType: "workspace",
        action: "declare_source",
        data: { workspaceId: WS, sourceEdges: [] },
      })
    );

    expect(perm).toMatchObject({ granted: true });
  });

  it("CONTROL: the person, signed in, creates a tool directly", async () => {
    const caller = await toolsCaller();
    const out = await caller.create({
      name: "person-made-tool",
      kind: "api",
      workspaceId: WS,
    });

    expect(out).toMatchObject({ status: "created", proposalId: null });
    expect(await toolsNamed("person-made-tool")).toHaveLength(1);
  });
});
