/**
 * The standalone-config engine writes a skill's `metadata.marketSource` through
 * the REAL `skills.update` door, on PGlite: what this pins is that the write
 * PERSISTS (the unit suite mocks the router, so it can only see the payload).
 * Only governance, audit, side effects and the catalog lookup are stubbed.
 *
 * Pinned:
 *  - a skill detach persists: the link reads as absent afterwards, every other
 *    metadata key kept, and the next reconcile no longer checks the row;
 *  - a reconcile whose fields already match the catalog stamps the catalog
 *    version and advances the baseline on the row, rewrites no field, keeps
 *    the skill's approval, and the next pass writes nothing.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  catalog: null as null | Record<string, unknown>,
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
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(),
}));
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("../skills/skill-write-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertMayChangeSkill: async () => undefined,
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => {},
}));
vi.mock("./marketplace-install.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lookupCatalogEntry: async () => h.catalog,
}));
vi.mock("./official-catalog-trust.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  admitOfficialDefinition: async () => ({ admitted: true }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  reconcileStandaloneConfigsToTemplates,
  detachStandaloneConfigSource,
} from "./reconcile-standalone-configs-to-templates.js";
import { readMarketSource } from "./market-source.js";

const OWNER = randomUUID();
const SKILL = randomUUID();

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
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function skillRow() {
  const { rows } = await q(
    `select body, approved, metadata from skills where id = $1`,
    [SKILL]
  );
  return rows[0] as {
    body: string;
    approved: boolean;
    metadata: Record<string, unknown>;
  };
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(`delete from skills;`);
  // facecam-edit as the founder's pod held it: the owner's body already equals
  // the catalog's, the baseline and the version are the install's.
  await q(
    `insert into skills (id, user_id, workspace_id, name, kind, scope, body, execution_mode, approved, metadata)
     values ($1,$2,null,'Facecam edit','instruction','user','catalog body','sync',true,$3::jsonb)`,
    [
      SKILL,
      OWNER,
      JSON.stringify({
        keep: "me",
        marketSource: {
          packageSlug: "facecam-edit",
          packageVersion: "h-1",
          installedAt: "2026-10-01T00:00:00.000Z",
          baseline: { body: "installed body" },
        },
      }),
    ]
  );
  h.catalog = {
    source: "https://cp.example",
    version: "h-2",
    definition: { skill: { name: "Facecam edit", body: "catalog body" } },
  };
});

describe("skill metadata written by the standalone reconcile persists", () => {
  it("a skill detach persists: the link reads absent, other keys kept", async () => {
    const res = await detachStandaloneConfigSource({
      kind: "skill",
      id: SKILL,
      userId: OWNER,
    });
    expect(res).toMatchObject({ detached: true, outcome: "updated" });

    const row = await skillRow();
    expect(row.metadata.marketSource).toBeNull();
    expect(row.metadata.keep).toBe("me");
    expect(readMarketSource(row.metadata)).toBeNull();

    const report = await reconcileStandaloneConfigsToTemplates({
      ids: [SKILL],
    });
    expect(report.checked).toBe(0);
  });

  it("a row already equal to the catalog is stamped, not rewritten", async () => {
    const report = await reconcileStandaloneConfigsToTemplates({
      ids: [SKILL],
    });
    expect(report.ownerOwnedSkipped).toEqual([]);
    expect(report.skipped[0]!.reason).toContain("recorded version h-2");

    const row = await skillRow();
    const source = readMarketSource(row.metadata)!;
    expect(source.packageVersion).toBe("h-2");
    expect(source.comparatorVersion).toBe(1);
    expect(source.baseline).toEqual({ body: "catalog body" });
    expect(row.body).toBe("catalog body");
    expect(row.approved).toBe(true);
    expect(row.metadata.keep).toBe("me");

    const again = await reconcileStandaloneConfigsToTemplates({
      ids: [SKILL],
    });
    expect(again.skipped[0]!.reason).toBe("up to date (no drift)");
  });
});
