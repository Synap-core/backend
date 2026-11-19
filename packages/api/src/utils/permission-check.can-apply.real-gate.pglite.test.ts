/**
 * THE ONE FILING CHECK through the REAL gate (plan 8032a127 D1):
 * `checkPermissionOrPropose` → the agent's policy proposes → `createProposal`
 * asks `proposalCannotApply` before its transaction → a proposal its approval
 * would refuse comes back as the gate's `{ denied, reason, reasonCode }`, and
 * NO proposals row is written. On PGlite with every @synap/database table;
 * only the event append and side effects are stubbed.
 *
 * The kind is `command/execute`: it always proposes for an agent (rung 2.06,
 * `ARBITRARY_EXECUTION`), and its entry is the materializer's own
 * `commandPolicyRefusal`. Rows, each ruling out a wrong outcome:
 *  - a shell substitution: denied with COMMAND_REFUSED and the materializer's
 *    sentence, 0 rows: rules out "refused, but filed anyway" and "the refusal
 *    escaped as a thrown error instead of the gate's denial";
 *  - CONTROL, a command that can run: filed pending, as before: rules out "the
 *    check refuses every command".
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
        // (as entity.delete.real-gate.pglite.test.ts does).
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

const { auditSpy } = vi.hoisted(() => ({
  auditSpy: vi.fn(async (_opts: Record<string, unknown>) => ({
    id: globalThis.crypto.randomUUID(),
  })),
}));

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
vi.mock("./audit-log.js", () => ({ auditLog: auditSpy }));
vi.mock("./domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("./split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { checkPermissionOrPropose } from "./permission-check.js";


const OWNER = randomUUID();
const AGENT = randomUUID();

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

const proposalRows = async () =>
  (
    await q<{ status: string }>(
      `select status from proposals where created_by = $1 or agent_user_id = $1`,
      [AGENT]
    )
  ).rows;

const runCommand = (command: string) =>
  checkPermissionOrPropose({
    userId: OWNER,
    agentUserId: AGENT,
    subjectType: "command",
    action: "execute",
    source: "intelligence",
    data: { command, reason: "check the box" },
  });

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
     values ($1, $2, 'agent', $3, 'claude-code')`,
    [AGENT, "agent@x.test", OWNER]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from proposals;`);
});

describe("the gate answers a proposal that cannot apply with its denial (createProposal)", () => {
  it("a command the materializer would refuse: denied with its code and sentence, NO proposals row", async () => {
    const perm = await runCommand("echo $(whoami)");

    expect(perm).toEqual({
      denied: true,
      reason:
        "Shell substitution (backticks, $()) is not allowed. Run commands directly.",
      reasonCode: "COMMAND_REFUSED",
    });
    expect(await proposalRows()).toEqual([]);
  });

  it("CONTROL: a command that can run is filed pending, as before", async () => {
    const perm = await runCommand("ls -la");

    expect(perm).toMatchObject({
      granted: false,
      proposalId: expect.any(String),
    });
    expect(await proposalRows()).toEqual([{ status: "pending" }]);
  });
});
