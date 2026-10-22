/**
 * HOME-SPACE VISIBILITY (founder decision 2026-10-22, pod issue 2a743336), on
 * PGlite through the REAL readers and doors:
 *   - `entities.get` / `entities.list` (no lens, the space's lens, the pod
 *     lens) → `entityReadVisibleWhere` / `entityLensWhere` → `accessScopeWhere`;
 *   - the `entities` and `documents` VisibilityRules (`scopedDb`), and
 *     `loadReadableDocument` / `canEditDocument` (a document follows its
 *     entity, read only);
 *   - `entities.update` / `entities.delete` — the WRITE gate, unchanged.
 *
 * The rule: a POD-WIDE entity homed in space W (`home_workspace_id = W`) is
 * readable by W's members. It stays pod-wide, so W's lens shows it, and a
 * member still cannot target it for a write.
 *
 * Users:
 *   OWNER    — author, member of W, pod owner.
 *   MEMBER   — member of W, pod member.
 *   OUTSIDER — pod member, member of X only.
 *   GUEST    — a portal guest (guest role on a project, no participation).
 *
 * Rows (all owned by OWNER):
 *   E_HOMED   — pod-wide, home W, body D_HOMED.
 *   E_HOMED_X — pod-wide, home X (rules out "any homed row is shared").
 *   E_PLAIN   — pod-wide, no home, body D_PLAIN (rules out "every pod-wide
 *               row is shared" — it must stay owner-only).
 *   E_IN_W    — a W row (control: the workspace floor, unchanged).
 *   E_HOMED_FX — pod-wide, home W, AND a role facet in X: OUTSIDER reads it
 *               through the facet lens, so only the home-lens narrow's OWN
 *               membership gate keeps it out of a forged W lens.
 *
 * What this CANNOT see: production Postgres constraints (tables are generated
 * from the Drizzle definitions without FKs/CHECKs).
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { documents, entities } from "@synap/database/schema";
import { db, eq } from "@synap/database";
import { AccessContext, scopedDb } from "./index.js";
import { entitiesRouter } from "../routers/entities.js";
import { entityWriteVisibleWhere } from "../routers/entities/helpers.js";
import {
  canEditDocument,
  loadReadableDocument,
} from "../utils/document-edit-access.js";

const OWNER = "home-owner";
const MEMBER = "home-member";
const OUTSIDER = "home-outsider";
const GUEST = "home-guest";

const W = randomUUID();
const X = randomUUID();
const PROJECT = randomUUID();

const E_HOMED = randomUUID();
const E_HOMED_X = randomUUID();
const E_PLAIN = randomUUID();
const E_IN_W = randomUUID();
const E_HOMED_FX = randomUUID();
const D_HOMED = randomUUID();
const D_PLAIN = randomUUID();

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
const caller = (userId: string, workspaceId: string | null = null) =>
  entitiesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId,
  } as never);

const sorted = (ids: string[]) => [...new Set(ids)].sort();
const OURS = new Set<string>([E_HOMED, E_HOMED_X, E_PLAIN, E_IN_W, E_HOMED_FX]);
/** `entities.list` ids, restricted to this file's rows. */
async function listed(userId: string, lens?: string | null): Promise<string[]> {
  const res = (await caller(userId).list({
    limit: 100,
    ...(lens !== undefined ? { workspaceId: lens } : {}),
  } as never)) as { entities: Array<{ id: string }> };
  return sorted(res.entities.map((e) => e.id).filter((id) => OURS.has(id)));
}
async function got(userId: string, id: string): Promise<boolean> {
  try {
    await caller(userId).get({ id } as never);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "NOT_FOUND") return false;
    throw err;
  }
}
async function readable(userId: string, docId: string): Promise<boolean> {
  try {
    await loadReadableDocument(userId, docId);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "NOT_FOUND") return false;
    throw err;
  }
}
const seenDocs = async (userId: string) =>
  sorted(
    (
      await scopedDb(AccessContext.operator({ userId })).findMany<{
        id: string;
      }>(documents)
    )
      .map((d) => d.id)
      .filter((id) => id === D_HOMED || id === D_PLAIN)
  );

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [OWNER, MEMBER, OUTSIDER, GUEST]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@x.test`,
    ]);
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member'),($5,$6,'member')`,
    [randomUUID(), OWNER, randomUUID(), MEMBER, randomUUID(), OUTSIDER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,'W',$3,'team','{}'::jsonb),($2,'X',$3,'team','{}'::jsonb)`,
    [W, X, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$2,$5,'editor'),($6,$7,$8,'editor')`,
    [randomUUID(), W, OWNER, randomUUID(), MEMBER, randomUUID(), X, OUTSIDER]
  );
  // A portal guest: a guest role on a project, and no participation at all.
  await q(
    `insert into projects (id, name, workspace_id, user_id) values ($1,'Portal',$2,$3)`,
    [PROJECT, W, OWNER]
  );
  await q(
    `insert into project_members (id, project_id, user_id, role) values ($1,$2,$3,'guest')`,
    [randomUUID(), PROJECT, GUEST]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values (gen_random_uuid(),'decision','Decision','kind','system','pod',null,true,'{}'::jsonb)`
  );
  for (const d of [D_HOMED, D_PLAIN]) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,null,'Body','markdown',1,1)`,
      [d, OWNER]
    );
  }
  for (const [id, ws, home, doc] of [
    [E_HOMED, null, W, D_HOMED],
    [E_HOMED_X, null, X, null],
    [E_PLAIN, null, null, D_PLAIN],
    [E_IN_W, W, null, null],
    [E_HOMED_FX, null, W, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, home_workspace_id, type, title, document_id, properties, system_data, version)
       values ($1,$2,$3,$4,'decision','A decision',$5,'{}'::jsonb,'{}'::jsonb,1)`,
      [id, OWNER, ws, home, doc]
    );
  }
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id) values ($1,$2,$3,$4,$5)`,
    [randomUUID(), E_HOMED_FX, randomUUID(), OWNER, X]
  );
}, 120_000);

describe("a pod-wide entity filed FOR a space is readable by that space's members", () => {
  it("a member of the home space: get, list with no lens, the space's lens and the pod lens", async () => {
    expect(await got(MEMBER, E_HOMED)).toBe(true);
    expect(await listed(MEMBER)).toEqual(sorted([E_HOMED, E_HOMED_FX, E_IN_W]));
    // The space's own lens shows what was filed for it (no includePodWide).
    expect(await listed(MEMBER, W)).toEqual(
      sorted([E_HOMED, E_HOMED_FX, E_IN_W])
    );
    // It is pod-wide, so the POD view shows it too.
    expect(await listed(MEMBER, null)).toEqual(sorted([E_HOMED, E_HOMED_FX]));
  });

  it("its body document follows it — readable, never editable", async () => {
    expect(await readable(MEMBER, D_HOMED)).toBe(true);
    expect(await seenDocs(MEMBER)).toEqual([D_HOMED]);
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, D_HOMED));
    expect(await canEditDocument(MEMBER, doc!)).toEqual({
      allowed: false,
      reason: "not_owner",
    });
  });

  it("a pod-wide entity with NO home stays owner-only", async () => {
    expect(await got(MEMBER, E_PLAIN)).toBe(false);
    expect(await readable(MEMBER, D_PLAIN)).toBe(false);
    expect(await got(OWNER, E_PLAIN)).toBe(true);
    expect(await readable(OWNER, D_PLAIN)).toBe(true);
  });

  it("another pod member outside the space reads none of it — even forging the lens", async () => {
    expect(await got(OUTSIDER, E_HOMED)).toBe(false);
    expect(await readable(OUTSIDER, D_HOMED)).toBe(false);
    // Their own space's homed row, and the W-homed row they reach through a
    // role facet in X (the facet lens — not the home share).
    expect(await listed(OUTSIDER)).toEqual(sorted([E_HOMED_X, E_HOMED_FX]));
    expect(await listed(OUTSIDER, null)).toEqual([E_HOMED_X]);
    // `list` is a podProcedure: an input lens is never membership-checked, so
    // the home-lens narrow must gate on membership itself — a forged W lens
    // must not surface E_HOMED_FX as "filed for W".
    expect(await listed(OUTSIDER, W)).toEqual([]);
  });

  it("a portal guest reads none of it", async () => {
    expect(await got(GUEST, E_HOMED)).toBe(false);
    expect(await readable(GUEST, D_HOMED)).toBe(false);
    expect(await listed(GUEST)).toEqual([]);
    expect(await seenDocs(GUEST)).toEqual([]);
  });

  it("the owner still reads everything it authored (solo view unchanged)", async () => {
    expect(await listed(OWNER)).toEqual(
      sorted([E_HOMED, E_HOMED_X, E_PLAIN, E_IN_W, E_HOMED_FX])
    );
  });
});

describe("seeing is not targeting — the write gate is unchanged", () => {
  it("the write floor does not admit the homed row for a member", async () => {
    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(entityWriteVisibleWhere(MEMBER));
    expect(rows.map((r) => r.id)).not.toContain(E_HOMED);
    expect(rows.map((r) => r.id)).toContain(E_IN_W);
  });

  it("a member cannot update or delete it through the real doors", async () => {
    await expect(
      caller(MEMBER).update({ id: E_HOMED, title: "Hijacked" } as never)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(MEMBER).delete({ id: E_HOMED } as never)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { rows } = await q(
      `select title, deleted_at from entities where id = $1`,
      [E_HOMED]
    );
    expect(rows[0]).toEqual({ title: "A decision", deleted_at: null });
  });
});
