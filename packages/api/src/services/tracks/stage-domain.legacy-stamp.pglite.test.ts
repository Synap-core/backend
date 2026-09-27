/**
 * Stage-domain resolution accepts the LEGACY `settings.packageSlug` stamp
 * (FX-B1, RV2 S7) — through the REAL resolver, visibility floor and write
 * probe on PGlite.
 *
 * Why: pods whose workspaces predate the promoted `package_slug` column carry
 * the template identity only in `settings`. The resolver read only the column,
 * so such a pod answered `no_workspace` and every stage fell back to the
 * project's home — reported, but wrong.
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
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  listMissingStageDomains,
  resolveStageDomainWorkspace,
  workspacePackageSlug,
} from "./stage-domain.js";

const A = randomUUID();
const FIN = randomUUID(); // settings-only identity
const PROJECT = randomUUID();

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

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'a@x.test')`, [A]);
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, package_slug, settings)
     values ($1,'Finance',$2,'personal',null,'{"packageSlug":"finance"}'::jsonb)`,
    [FIN, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), FIN, A]
  );
}, 120_000);

describe("stage domain — legacy settings.packageSlug stamp", () => {
  const db = () => h.db as never;

  it("resolves a workspace stamped only in settings", async () => {
    const r = await resolveStageDomainWorkspace(db(), {
      slug: "finance",
      projectId: PROJECT,
      userId: A,
    });
    expect(r).toMatchObject({ resolved: true, workspaceId: FIN });
  });

  it("does not report it missing, and reads its slug back", async () => {
    expect(
      await listMissingStageDomains(
        db(),
        [{ key: "money", title: "Money", domain: "finance" }],
        A
      )
    ).toEqual([]);
    expect(await workspacePackageSlug(db(), FIN)).toBe("finance");
  });
});
