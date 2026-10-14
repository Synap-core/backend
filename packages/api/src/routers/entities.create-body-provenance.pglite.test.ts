/**
 * The body document of an entity carries the SAME provenance as the entity
 * (ticket 7b49aaae side-finding). Through the REAL `entities.create` on PGlite:
 * an agent-authored create with long-form content wrote an `ai_agent` entity
 * whose body document was hard-stamped `createdByKind: "human"` — so recall /
 * landed-outputs credited the human with the agent's prose. Governance, audit,
 * side effects and object storage are stubbed.
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
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
  isJoinGate: vi.fn(() => false),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
    upload: async (key: string, body: string | Buffer) => ({
      url: key,
      path: key,
      size: String(body).length,
      checksum: "sha256:x",
    }),
    delete: async () => undefined,
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { entitiesRouter } from "./entities.js";

const A = randomUUID();
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

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const caller = () =>
  entitiesRouter.createCaller({
    authenticated: true,
    userId: A,
    workspaceId: WS,
  } as never);

// Four paragraphs ⇒ `shouldMaterializeAsDocument` ⇒ a linked body document.
const LONG_BODY = ["One.", "Two.", "Three.", "Four."].join("\n\n");

type Stamp = {
  created_by_kind: string;
  created_by_user_id: string;
  agent_user_id: string | null;
  correlation_id: string | null;
};
async function stamps(
  entityId: string
): Promise<{ entity: Stamp; doc: Stamp }> {
  const e = await q(
    `select document_id, created_by_kind, created_by_user_id, agent_user_id, correlation_id from entities where id = $1`,
    [entityId]
  );
  const entity = e.rows[0] as Stamp & { document_id: string | null };
  expect(entity.document_id).toBeTruthy();
  const d = await q(
    `select created_by_kind, created_by_user_id, agent_user_id, correlation_id from documents where id = $1`,
    [entity.document_id]
  );
  return { entity, doc: d.rows[0] as Stamp };
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1, 'a@x.test')`, [A]);
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,'Builder',$2,'team','{}'::jsonb)`,
    [WS, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, A]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, applicable_kinds)
     values (gen_random_uuid(),'note','Note','kind','system','workspace',null,true,'{}'::jsonb,null)`
  );
}, 120_000);

describe("entities.create — the body document is stamped like its entity", () => {
  it("an agent-authored body is `ai_agent` with the agent's id, not `human`", async () => {
    const res = (await caller().create({
      profileSlug: "note",
      title: "Agent essay",
      content: LONG_BODY,
      agentUserId: AGENT,
    } as never)) as { id: string };
    const { entity, doc } = await stamps(res.id);
    expect(entity.created_by_kind).toBe("ai_agent");
    expect(doc).toEqual({
      created_by_kind: "ai_agent",
      created_by_user_id: A,
      agent_user_id: AGENT,
      correlation_id: entity.correlation_id,
    });
  });

  it("a human-authored body stays `human`", async () => {
    const res = (await caller().create({
      profileSlug: "note",
      title: "Human essay",
      content: LONG_BODY,
    } as never)) as { id: string };
    const { doc } = await stamps(res.id);
    expect(doc.created_by_kind).toBe("human");
    expect(doc.agent_user_id).toBeNull();
  });
});
