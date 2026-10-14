/**
 * `projects.forEntity` — the projects a THING is filed into (D5: several),
 * through the REAL procedure on PGlite: the real entity read floor
 * (`entityReadVisibleWhere`), the real `projects` VisibilityRule (scopedDb)
 * and real `belongs_to_project` edges. Only the event bus, audit log and side
 * effects are stubbed (the router module imports them; nothing here writes).
 *
 *   T     — U's thing in WS, filed into Beta (active), Alpha (archived),
 *           OTHER's private project, and a deleted project (edge left behind).
 *   LOOSE — U's thing in no project.
 *   PRIV  — OTHER's pod-personal thing U cannot read.
 *
 * What this CANNOT see: production Postgres constraints; member-shared
 * projects (no project_members rows seeded).
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
  const noop = new Proxy(
    {},
    { get: (_t, k) => (k === "then" ? undefined : async () => undefined) }
  );
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: noop,
    EventRepository: class {
      constructor() {
        return noop;
      }
    },
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { projectsRouter } from "./projects.js";

const U = randomUUID();
const OTHER = randomUUID();
const WS = randomUUID();
const KIND = randomUUID();

const BETA = randomUUID();
const ALPHA = randomUUID();
const THEIRS = randomUUID();
const GONE = randomUUID();

const T = randomUUID();
const LOOSE = randomUUID();
const PRIV = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const caller = () =>
  projectsRouter.createCaller({
    authenticated: true,
    userId: U,
    workspaceId: null,
  } as never);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [U, OTHER]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@example.test`,
    ]);
    await q(
      `insert into pod_members (id, user_id, pod_role) values ($1,$2,'member')`,
      [randomUUID(), u]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [WS, U]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, U]
  );
  for (const [id, owner, name, status, slot, icon] of [
    [BETA, U, "Beta", "active", 3, "🚀"],
    [ALPHA, U, "Alpha", "archived", null, "glyph:rocket"],
    [THEIRS, OTHER, "Theirs", "active", null, null],
  ] as const) {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status, color_slot, icon, settings, metadata) values ($1,$2,null,$3,$4,$5,$6,'{}'::jsonb,'{}'::jsonb)`,
      [id, owner, name, status, slot, icon]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope) values ($1,'thing','Thing','kind','system')`,
    [KIND]
  );
  for (const [id, owner, ws] of [
    [T, U, WS],
    [LOOSE, U, WS],
    [PRIV, OTHER, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, version) values ($1,$2,$3,$4,'thing','e','{}'::jsonb,1)`,
      [id, owner, ws, KIND]
    );
  }
  for (const project of [BETA, ALPHA, THEIRS, GONE]) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'belongs_to_project')`,
      [randomUUID(), U, WS, T, project]
    );
  }
  // An edge of another type to a project is not filing.
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'mentions')`,
    [randomUUID(), U, WS, LOOSE, BETA]
  );
}, 120_000);

describe("projects.forEntity — a thing's projects (D5)", () => {
  it("every project it is filed into that the caller can see, by name, archived included", async () => {
    expect(await caller().forEntity({ entityId: T })).toEqual({
      projects: [
        {
          id: ALPHA,
          name: "Alpha",
          status: "archived",
          colorSlot: null,
          icon: "glyph:rocket",
        },
        { id: BETA, name: "Beta", status: "active", colorSlot: 3, icon: "🚀" },
      ],
    });
  });

  it("another user's private project is never named; a deleted one is gone", async () => {
    const ids = (await caller().forEntity({ entityId: T })).projects.map(
      (p) => p.id
    );
    expect(ids).not.toContain(THEIRS);
    expect(ids).not.toContain(GONE);
  });

  it("a thing in no project ⇒ [] (a mention is not filing)", async () => {
    expect(await caller().forEntity({ entityId: LOOSE })).toEqual({
      projects: [],
    });
  });

  it("a thing the caller cannot read ⇒ NOT_FOUND, never an empty list", async () => {
    for (const entityId of [PRIV, randomUUID()]) {
      await expect(caller().forEntity({ entityId })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
  });
});
