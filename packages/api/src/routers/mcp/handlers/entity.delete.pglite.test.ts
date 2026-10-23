/**
 * `synap_delete_entity` (decision B9b) — the agent's delete is the GOVERNED
 * SOFT delete, never a second path and never the hard delete.
 *
 * Driven on PGlite through the REAL chain an MCP call takes: the MCP handler →
 * the real hub caller (`createHubProtocolCaller`, the same builder the MCP
 * adapter uses) → hub `entities.deleteEntity` → `entities.delete`. Only the
 * governance call is a spy, so the test can read WHAT it was asked and choose
 * its answer; the decision itself is `decideAgentPolicy`'s DESTRUCTIVE floor
 * (rung 2.5), pinned by governance-policy `non-widenable-floor.test.ts` and
 * `rule-attribution.test.ts` ("a floor above rung 2.8 wins … delete stays
 * propose"). What this file pins is the SEAM: the agent reaches that floor as
 * an agent, on the delete action, and a proposal leaves the row untouched.
 *
 * Rows that rule out a wrong rule:
 *  - the gate sees `{ subjectType: entity, action: delete, agentUserId }` — a
 *    door that dropped `agentUserId` would be governed as the human and could
 *    execute inline;
 *  - proposed ⇒ the row is NOT deleted, and the receipt says nothing landed;
 *  - allowed (a non-agent principal) ⇒ `deletedAt` is set and the row still
 *    exists — the soft door, not `adminDelete`;
 *  - another person's entity ⇒ refused before any proposal is filed.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  gateCalls: [] as Array<Record<string, unknown>>,
  gateAnswer: {} as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../utils/permission-check.js")>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(async (args: Record<string, unknown>) => {
      h.gateCalls.push(args);
      return h.gateAnswer;
    }),
  };
});
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
  getBoss: () => ({ send: async () => null }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { entityHandlers } from "./entity.js";
import { createHubProtocolCaller, type McpToolContext } from "./shared.js";

const OWNER = randomUUID();
const OTHER = randomUUID();
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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function seedEntity(ownerId: string, title: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties)
     values ($1, $2, null, $3, 'note', $4, '{}'::jsonb)`,
    [id, ownerId, NOTE_PROFILE, title]
  );
  return id;
}
async function deletedAt(id: string): Promise<unknown> {
  const { rows } = await q(`select deleted_at from entities where id = $1`, [
    id,
  ]);
  expect(rows).toHaveLength(1); // the row is never removed
  return (rows[0] as { deleted_at: unknown }).deleted_at;
}

async function callDelete(args: Record<string, unknown>) {
  const lensCaller = await createHubProtocolCaller(
    OWNER,
    ["mcp.read", "mcp.write"],
    AGENT
  );
  const result = await entityHandlers.synap_delete_entity!({
    toolName: "synap_delete_entity",
    args,
    userId: OWNER,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    lensCaller,
    caller: lensCaller,
  } as unknown as McpToolContext);
  const text = (result.content as Array<{ text?: string }>)
    .map((c) => c.text ?? "")
    .join("");
  return { result, text };
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  for (const [id, email] of [
    [OWNER, "owner@x.test"],
    [OTHER, "other@x.test"],
  ])
    await q(`insert into users (id, email) values ($1, $2)`, [id, email]);
  const { rows } = await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values (gen_random_uuid(),'note','Note','kind','system','pod',null,true,'{}'::jsonb) returning id`
  );
  NOTE_PROFILE = (rows[0] as { id: string }).id;
}, 120_000);

beforeEach(() => {
  h.gateCalls = [];
});

describe("synap_delete_entity — the governed soft delete, as the agent", () => {
  it("files a delete proposal AS the agent and deletes nothing", async () => {
    const id = await seedEntity(OWNER, "Mistaken note");
    h.gateAnswer = {
      proposalId: "prop-del-1",
      proposalType: "entity.delete",
      reviewUrl: "https://pod.test/review/prop-del-1",
    };

    const { result, text } = await callDelete({
      entityId: id,
      reasoning: "I created it twice",
    });

    expect(result.isError).not.toBe(true);
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      subjectType: "entity",
      action: "delete",
      agentUserId: AGENT,
      reasoning: "I created it twice",
      data: { id },
    });
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      entityId: id,
      status: "proposed",
      proposalId: "prop-del-1",
    });
    expect(payload.landed).toMatch(/^Nothing is deleted yet/);
    expect(await deletedAt(id)).toBeNull();
  });

  it("when the gate allows (a non-agent principal): a SOFT delete, row kept", async () => {
    const id = await seedEntity(OWNER, "Allowed note");
    h.gateAnswer = { allowed: true };

    const { text } = await callDelete({ entityId: id });

    expect(await deletedAt(id)).not.toBeNull();
    expect((JSON.parse(text) as { landed: string }).landed).toMatch(
      /soft delete/
    );
  });

  it("another person's entity is refused before any proposal is filed", async () => {
    const theirs = await seedEntity(OTHER, "Their note");
    h.gateAnswer = { proposalId: "should-not-exist" };

    const outcome = await callDelete({ entityId: theirs }).catch(
      (err: unknown) => err
    );

    expect(String(outcome)).toMatch(/not found/i);
    expect(h.gateCalls).toHaveLength(0);
    expect(await deletedAt(theirs)).toBeNull();
  });
});
