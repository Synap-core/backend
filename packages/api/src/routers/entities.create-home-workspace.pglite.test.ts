/**
 * The create doors record the space a POD-WIDE entity was filed FOR
 * (`entities.home_workspace_id`, 0348) — through the REAL `entities.create`,
 * `entities.batchCreate`, `entities.moveToWorkspace` and `entities.update`
 * procedures and the REAL placement door on PGlite. Governance, audit, side
 * effects and search indexing are stubbed.
 *
 * Pinned:
 *  - a pod-scope kind written from W ⇒ pod-wide, homed in W (single + bulk);
 *  - a workspace-scope kind ⇒ lands in W, no home (single + bulk);
 *  - `global: true`, an explicit pin, or no workspace at all ⇒ no home;
 *  - only a member of a space may name it as the home;
 *  - a proposal-gated create persists the home beside `resolvedWorkspaceId`;
 *  - moving into a space clears the home; promoting a W row to pod-wide homes
 *    it in W.
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
import { entitiesRouter } from "./entities.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";

const A = randomUUID();
const OTHER = randomUUID();
const W = randomUUID();
const X = randomUUID();
const FOREIGN = randomUUID(); // a space A is not a member of

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
const caller = (workspaceId: string | null) =>
  entitiesRouter.createCaller({
    authenticated: true,
    userId: A,
    workspaceId,
  } as never);

type Placed = { workspace: string | null; home: string | null };
async function placed(id: string): Promise<Placed> {
  const { rows } = await q(
    `select workspace_id, home_workspace_id from entities where id = $1`,
    [id]
  );
  const r = rows[0] as {
    workspace_id: string | null;
    home_workspace_id: string | null;
  };
  return { workspace: r.workspace_id, home: r.home_workspace_id };
}
const create = async (
  workspaceId: string | null,
  input: Record<string, unknown>
) => ((await caller(workspaceId).create(input as never)) as { id: string }).id;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email) values ($1, 'a@x.test'), ($2, 'o@x.test')`,
    [A, OTHER]
  );
  for (const [ws, name, owner] of [
    [W, "Team", A],
    [X, "Other team", A],
    [FOREIGN, "Not mine", OTHER],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,$2,$3,'team','{}'::jsonb)`,
      [ws, name, owner]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, owner]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values (gen_random_uuid(),'decision','Decision','kind','system','pod',null,true,'{}'::jsonb),
            (gen_random_uuid(),'deal','Deal','kind','system','workspace',null,true,'{}'::jsonb)`
  );
}, 120_000);

describe("create doors record the space a pod-wide entity was filed for", () => {
  it("single create: a pod-scope kind from W lands pod-wide, homed in W", async () => {
    const id = await create(W, { profileSlug: "decision", title: "Ship it" });
    expect(await placed(id)).toEqual({ workspace: null, home: W });
  });

  it("single create: a workspace-scope kind lands IN W, with no home", async () => {
    const id = await create(W, { profileSlug: "deal", title: "Big deal" });
    expect(await placed(id)).toEqual({ workspace: W, home: null });
  });

  it("global: true, an explicit pin, or no workspace ⇒ no home", async () => {
    const global = await create(W, {
      profileSlug: "decision",
      title: "Everyone's",
      global: true,
    });
    expect(await placed(global)).toEqual({ workspace: null, home: null });
    const pinned = await create(W, {
      profileSlug: "decision",
      title: "Pinned",
      targetWorkspaceId: X,
    });
    expect(await placed(pinned)).toEqual({ workspace: X, home: null });
    const nowhere = await create(null, {
      profileSlug: "decision",
      title: "Mine",
    });
    expect(await placed(nowhere)).toEqual({ workspace: null, home: null });
  });

  it("a named home: honoured for a member, refused for a non-member", async () => {
    const id = await create(null, {
      profileSlug: "decision",
      title: "Filed for X",
      homeWorkspaceId: X,
    });
    expect(await placed(id)).toEqual({ workspace: null, home: X });
    await expect(
      create(null, {
        profileSlug: "decision",
        title: "Smuggled",
        homeWorkspaceId: FOREIGN,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a proposal-gated create persists the home for the materializer", async () => {
    const gate = vi.mocked(checkPermissionOrPropose);
    gate.mockResolvedValueOnce({
      proposalId: randomUUID(),
      proposalType: "entity.create",
    } as never);
    const res = (await caller(W).create({
      profileSlug: "decision",
      title: "Needs review",
    } as never)) as { status: string };
    expect(res.status).toBe("proposed");
    const data = gate.mock.calls.at(-1)![0].data as Record<string, unknown>;
    expect(data.resolvedWorkspaceId).toBeNull();
    expect(data.resolvedHomeWorkspaceId).toBe(W);
  });

  it("bulk create: the header homes a pod-scope kind and pins a workspace-scope one", async () => {
    const res = await caller(W).batchCreate({
      entities: [
        { refKey: "d", profileSlug: "decision", title: "Bulk decision" },
        { refKey: "deal", profileSlug: "deal", title: "Bulk deal" },
      ],
    });
    expect(res.errors).toEqual([]);
    expect(await placed(res.entityIds.d!)).toEqual({
      workspace: null,
      home: W,
    });
    expect(await placed(res.entityIds.deal!)).toEqual({
      workspace: W,
      home: null,
    });
  });
});

describe("moves keep the home coherent", () => {
  it("moving a homed entity INTO a space clears its home", async () => {
    const id = await create(W, { profileSlug: "decision", title: "Move me" });
    const res = await caller(null).moveToWorkspace({
      entityIds: [id],
      workspaceId: X,
    });
    expect(res.errors).toEqual([]);
    expect(await placed(id)).toEqual({ workspace: X, home: null });
  });

  it("promoting a W row to pod-wide homes it in W", async () => {
    const id = await create(W, { profileSlug: "deal", title: "Promote me" });
    await caller(W).update({ id, global: true } as never);
    expect(await placed(id)).toEqual({ workspace: null, home: W });
  });
});
