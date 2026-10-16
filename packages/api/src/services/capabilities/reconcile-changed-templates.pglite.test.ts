/**
 * OV-05: a catalog publish reaches pods that already installed the pack.
 *
 * After each official catalog sync the api converges the installed
 * containers whose template the cache now holds at a DIFFERENT content hash
 * (`reconcileChangedCapabilityTemplates`, through the boot reconcile's own
 * door). Driven on PGlite (every schema table) with the template fetch
 * stubbed to the cached version:
 *   - only a container whose stamp differs from the cache is picked (not an
 *     up-to-date one, not one with no template key, not one whose template
 *     left the catalog);
 *   - the reconcile converges it: its stamp then equals the cache, and the
 *     next pass finds nothing;
 *   - a container the reconcile cannot converge is attempted ONCE per
 *     published version, not every ten minutes.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  /** The template the stubbed CP fetch serves, by key. */
  templates: new Map<string, Record<string, unknown>>(),
  fetched: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async (key: string) => {
    h.fetched.push(key);
    return h.templates.get(key) ?? null;
  }),
}));

import { pgliteTableDdl } from "../../__tests__/pglite-ddl.js";
import {
  containersWithChangedTemplates,
  reconcileChangedCapabilityTemplates,
  resetChangedTemplateAttempts,
} from "./reconcile-capabilities-to-templates.js";
import { DRIFT_COMPARATOR_VERSION } from "./capability-drift.js";

const U = "22222222-2222-2222-2222-222222222222";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function container(
  id: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await q(
    `insert into capabilities (id, name, created_by, metadata) values ($1, $2, $3, $4::jsonb)`,
    [id, `C ${id.slice(-4)}`, U, JSON.stringify(metadata)]
  );
}
async function cached(slug: string, contentHash: string): Promise<void> {
  await q(
    `insert into cp_catalog_cache (source, kind, slug, name, content_hash, definition) values ('https://api.synap.live', 'capability', $1, $1, $2, $3::jsonb)`,
    [
      slug,
      contentHash,
      JSON.stringify({ key: slug, name: slug, tools: [], skills: [] }),
    ]
  );
  h.templates.set(slug, {
    key: slug,
    name: slug,
    tools: [],
    skills: [],
    contentHash,
  });
}
const stampOf = async (id: string) =>
  (
    await q<{ metadata: Record<string, unknown> }>(
      `select metadata from capabilities where id = $1`,
      [id]
    )
  ).rows[0]!.metadata;

const CHANGED = "aaaaaaaa-0000-4000-8000-000000000001";
const CURRENT = "aaaaaaaa-0000-4000-8000-000000000002";
const NO_KEY = "aaaaaaaa-0000-4000-8000-000000000003";
const GONE = "aaaaaaaa-0000-4000-8000-000000000004";

beforeAll(async () => {
  const schema = await import("@synap/database/schema");
  const seen = new Set<string>();
  for (const v of Object.values(schema)) {
    if (!is(v, PgTable)) continue;
    const name = getTableConfig(v).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(pgliteTableDdl(v));
  }
  expect(seen.has("capabilities")).toBe(true);
  expect(seen.has("cp_catalog_cache")).toBe(true);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from capabilities; delete from cp_catalog_cache;`
  );
  h.templates.clear();
  h.fetched.length = 0;
  resetChangedTemplateAttempts();
  await cached("apify", "h-new");
  await cached("other", "h-same");
  await container(CHANGED, {
    templateKey: "apify",
    contentHash: "h-old",
    comparatorVersion: DRIFT_COMPARATOR_VERSION,
  });
  await container(CURRENT, {
    templateKey: "other",
    contentHash: "h-same",
    comparatorVersion: DRIFT_COMPARATOR_VERSION,
  });
  await container(NO_KEY, {});
  await container(GONE, { templateKey: "retired-pack", contentHash: "h-x" });
});

describe("after a catalog publish, installed templates converge (OV-05)", () => {
  it("picks only the container whose template changed", async () => {
    expect((await containersWithChangedTemplates()).map((c) => c.id)).toEqual([
      CHANGED,
    ]);
  });

  it("converges it through the reconcile door: its stamp then matches, the next pass finds nothing", async () => {
    const report = await reconcileChangedCapabilityTemplates();
    expect(report?.checked).toBe(1);
    expect(h.fetched).toEqual(["apify"]);
    expect(await stampOf(CHANGED)).toMatchObject({
      templateKey: "apify",
      contentHash: "h-new",
      comparatorVersion: DRIFT_COMPARATOR_VERSION,
    });
    expect(await containersWithChangedTemplates()).toEqual([]);
    expect(await reconcileChangedCapabilityTemplates()).toBeNull();
  });

  it("a container that cannot converge is attempted once per published version", async () => {
    // The template fetch fails: the reconcile skips it, the stamp stays old.
    h.templates.delete("apify");
    await reconcileChangedCapabilityTemplates();
    expect(h.fetched).toEqual(["apify"]);
    expect(await reconcileChangedCapabilityTemplates()).toBeNull();
    expect(h.fetched).toEqual(["apify"]);
    // A NEWER publish is a new attempt.
    await q(
      `update cp_catalog_cache set content_hash = 'h-newer' where slug = 'apify'`
    );
    await reconcileChangedCapabilityTemplates();
    expect(h.fetched).toEqual(["apify", "apify"]);
  });
});
