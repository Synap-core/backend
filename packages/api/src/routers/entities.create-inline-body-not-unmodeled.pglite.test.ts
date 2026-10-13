/**
 * A short body inlined as `properties.content` is NOT an "unmodeled" key
 * (the #7/#20 bug, second place). Through the REAL `entities.create` on PGlite
 * — the same door the approve-time replay runs (`proposals/executors/entity.ts`
 * replays `entities.create` with the proposal's `content`): a short `content`
 * on a profile that does not model `content` is folded into the property bag
 * as the entity's body, and the repository's validator then reported it under
 * `unmodeled`, so the receipt told the agent it had invented a key. Same rule
 * as the capture preflight (commit a044f79a): a `content` the caller put in
 * `properties` still reports. Governance, audit, side effects and object
 * storage are stubbed.
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

describe("entities.create — an inlined body is not an unmodeled key", () => {
  it("a short `content` lands inline and is NOT reported as unmodeled", async () => {
    const res = (await caller().create({
      profileSlug: "note",
      title: "Short note",
      content: "One line.",
      properties: { stauts: "open" },
    } as never)) as {
      id: string;
      unmodeled?: Array<{ key: string }>;
      entity: { unmodeled?: Array<{ key: string }> };
    };
    // Non-vacuity: the body really was folded into the bag (the case at issue).
    const row = await q(`select properties from entities where id = $1`, [
      res.id,
    ]);
    expect(
      (row.rows[0] as { properties: Record<string, unknown> }).properties
        .content
    ).toBe("One line.");
    // The invented key still reports; the body does not — on the receipt and
    // on the entity it carries.
    expect(res.unmodeled?.map((u) => u.key)).toEqual(["stauts"]);
    expect(res.entity.unmodeled?.map((u) => u.key)).toEqual(["stauts"]);
  });

  it("a `content` the caller put in `properties` still reports", async () => {
    const res = (await caller().create({
      profileSlug: "note",
      title: "Inline content key",
      properties: { content: "x" },
    } as never)) as { unmodeled?: Array<{ key: string }> };
    expect(res.unmodeled?.map((u) => u.key)).toEqual(["content"]);
  });
});
