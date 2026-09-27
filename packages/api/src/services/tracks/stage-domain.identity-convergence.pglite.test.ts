/**
 * CONVERGENCE: the pod's SQL identity read (`templateSlugExpr` =
 * `coalesce(package_slug, settings->>'packageSlug')`, reached through
 * `workspacePackageSlug`) and the shared TS leaf every reader uses
 * (`workspaceTemplateSlug`, `@synap-core/types/units`) answer the SAME slug
 * for the same stored row. The SQL cannot import the leaf, so this pins them.
 *
 * ⚠️ A convergence test proves SAMENESS, never CORRECTNESS: if both read the
 * wrong field identically, this stays green. The rule itself is reviewed in
 * `stage-space.test.ts` (types). Rows sit where plausible readers DISAGREE:
 * column-only, settings-only, column ≠ stamp, empty-string column, neither.
 * (The pick precedence needs no convergence test: the resolver CALLS
 * `pickStageSpace`.)
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
import { workspaceTemplateSlug } from "@synap-core/types/units";
import { workspacePackageSlug } from "./stage-domain.js";

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

const A = randomUUID();

const ROWS: Array<{ id: string; column: string | null; settings: unknown }> = [
  { id: randomUUID(), column: "crm", settings: {} },
  { id: randomUUID(), column: null, settings: { packageSlug: "finance" } },
  { id: randomUUID(), column: "crm", settings: { packageSlug: "legacy" } },
  { id: randomUUID(), column: "", settings: { packageSlug: "stamp" } },
  { id: randomUUID(), column: null, settings: { other: 1 } },
];

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'a@x.test')`, [A]);
  for (const r of ROWS) {
    await q(
      `insert into workspaces (id, name, owner_id, workspace_type, package_slug, settings)
       values ($1,'W',$2,'personal',$3,$4::jsonb)`,
      [r.id, A, r.column, JSON.stringify(r.settings)]
    );
  }
}, 120_000);

describe("space template identity — SQL coalesce ≡ shared leaf", () => {
  it("answers the same slug for every stored row shape", async () => {
    const db = h.db as never;
    const pairs: Array<[string | null, string | null]> = [];
    for (const r of ROWS) {
      const { rows } = await q(
        `select package_slug, settings from workspaces where id = $1`,
        [r.id]
      );
      const raw = rows[0] as { package_slug: string | null; settings: unknown };
      pairs.push([
        await workspacePackageSlug(db, r.id),
        workspaceTemplateSlug({
          packageSlug: raw.package_slug,
          settings: raw.settings,
        }),
      ]);
    }
    // Non-vacuity: the fixture exercised both branches and the empty answer.
    expect(pairs.map(([sql]) => sql)).toEqual([
      "crm",
      "finance",
      "crm",
      "",
      null,
    ]);
    for (const [sql, leaf] of pairs) expect(leaf).toBe(sql);
  });
});
