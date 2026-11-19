/**
 * The filing rule at the package apply (app-permission plan 8189ae7c, W1
 * review): an app grant never decides what a project holds. An app that
 * applies a package into a space with a `projectId` used to file EVERY record
 * of the space into the project, right after the `uses` door had refused it.
 *
 * Real: `applyPackagePostWorkspace` (its project-link step), the `uses` door
 * (`linkProjectToWorkspace`, refuses an app's grant), `linkEntityToProject`
 * and the grant check (`existingEntitiesGrantMayFile`), on PGlite.
 *
 * Rows rule out: an app's apply filing records (the defect); a person's apply
 * filing nothing (the control: the step still works without a grant).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import { runWithGrant, type KeyGrant } from "@synap/database";
import { applyPackagePostWorkspace } from "../package-apply-post-workspace.js";

const ALICE = randomUUID();
const W = randomUUID();
const P = randomUUID();
const RECORDS = [randomUUID(), randomUUID()];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const filed = async () =>
  (
    (await q(
      `select source_entity_id as id from relations where type = 'belongs_to_project' and target_entity_id = $1`,
      [P]
    )) as { rows: Array<{ id: string }> }
  ).rows.map((r) => r.id);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // The `uses` edge insert names this index (`createLink` onConflict).
  await q(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, user_type) values ($1,'a@x','human')`,
    [ALICE]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'w',$2,'{}'::jsonb)`,
    [W, ALICE]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W, ALICE]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1,$2,null,'P','active')`,
    [P, ALICE]
  );
  for (const id of RECORDS) {
    await q(
      `insert into entities (id, type, user_id, workspace_id) values ($1,'task',$2,$3)`,
      [id, ALICE, W]
    );
  }
}, 120_000);

const apply = () =>
  applyPackagePostWorkspace({
    workspaceId: W,
    userId: ALICE,
    body: { projectId: P } as never,
  });

describe("package apply: an app grant files nothing into a project (W1 filing rule)", () => {
  it("an app holding package.install applies with a projectId and files NO record", async () => {
    const app: KeyGrant = {
      scopes: [
        {
          permissions: ["package.install", "entity.read"],
          workspaceIds: [W],
        },
      ],
      clientId: "app-under-test",
    };
    const result = await runWithGrant(app, apply);
    expect(result.projectLink).toMatchObject({
      status: "not_linked",
      entities: 0,
    });
    expect(await filed()).toEqual([]);
  });

  it("CONTROL — the person's own apply (no grant) files the space's records", async () => {
    const result = await apply();
    // The whole receipt on a miss: an `error` names its cause.
    expect(JSON.stringify(result.projectLink)).toContain('"status":"linked"');
    expect((await filed()).sort()).toEqual([...RECORDS].sort());
  });
});
