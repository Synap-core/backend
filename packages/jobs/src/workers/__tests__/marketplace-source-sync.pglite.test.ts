/**
 * The source-removal race on a REAL engine (PGlite): the settings read under
 * `FOR SHARE`, the upsert-then-prune of `cp_catalog_cache`, and the admin
 * list's locked read-modify-write (`updateMarketplaceSources`, `FOR UPDATE`),
 * against real `pod_settings` jsonb and a real unique key. The mock-level test
 * (`marketplace-source-sync.test.ts`) proves the code asks for the lock; this
 * one proves the SQL does what the comment says:
 *   - a sync for a source still pinned writes exactly its rows and prunes the
 *     rest of THAT source only;
 *   - a remove (or key re-approval) committed first leaves the sync writing
 *     nothing — no rows, no status;
 *   - a sync and a remove started together end with no rows and no source, in
 *     either order;
 *   - a removed id's tombstone is written beside every other setting.
 *
 * What this cannot show: PGlite is ONE backend, so its transactions run one
 * after another and the `FOR SHARE` / `FOR UPDATE` row locks never contend.
 * The interleaving where a remove WAITS on a sync's share lock is Postgres
 * row-lock semantics, not exercised here — only that both orders the waiting
 * can produce leave the pod consistent.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client);
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

// The settings helpers live inside @synap/database and reach `db` through its
// own client module, so the engine is swapped at that seam (and at the
// package's export, for the worker's own imports).
vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

import {
  readMarketplaceSources,
  updateMarketplaceSources,
  type MarketplaceSourceSetting,
} from "@synap/database";
import {
  deleteSourceRows,
  syncThirdPartySource,
} from "../marketplace-source-sync.js";
import { keyFingerprint } from "../marketplace-source-verify.js";
import type { CatalogSource } from "../cp-catalog-sync.js";
import {
  FIXTURE_ORIGIN,
  makeKey,
  makeSource,
  type FixtureKey,
} from "./fixtures/marketplace-source.js";

const NOW = new Date("2026-10-13T12:00:00Z");

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.client!.exec(`
    create table pod_settings (
      id uuid primary key default gen_random_uuid(),
      settings jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table cp_catalog_cache (
      id uuid primary key default gen_random_uuid(),
      source text not null,
      kind text not null,
      slug text not null,
      name text not null,
      description text,
      version text,
      tier text,
      vendor text,
      tags text[],
      content_hash text,
      definition jsonb,
      listing jsonb,
      retired_at timestamptz,
      replaced_by_slug text,
      retired_reason text,
      synced_at timestamptz not null default now(),
      unique (source, kind, slug)
    );
  `);
}, 120_000);

function setting(key: FixtureKey): MarketplaceSourceSetting {
  return {
    id: "acme",
    url: FIXTURE_ORIGIN,
    name: "Acme Labs",
    trust: "trusted",
    publicKey: key.publicKey,
    keyFingerprint: keyFingerprint(key.publicKey),
    agentsMayPropose: false,
    addedBy: "user-1",
    addedAt: "2026-10-01T00:00:00Z",
    enabled: true,
  };
}

function catalogSource(key: FixtureKey): CatalogSource {
  return {
    ...setting(key),
    cacheKey: "acme",
    official: false,
    lockedOff: false,
    agentsMayPropose: false,
  } as CatalogSource;
}

const PACKAGES = [
  { slug: "crm", kind: "template", definition: { workspaceName: "CRM" } },
  {
    slug: "charts/bar",
    kind: "cell",
    definition: { key: "bar", code: "export default 1" },
  },
];

async function rows(source: string) {
  return (
    await q<{ kind: string; slug: string }>(
      `select kind, slug from cp_catalog_cache where source = $1 order by slug`,
      [source]
    )
  ).rows;
}

async function settings() {
  return (
    await q<{ settings: Record<string, unknown> }>(
      `select settings from pod_settings`
    )
  ).rows[0]!.settings;
}

/** The router's remove: the locked list write (with its tombstone), then the rows. */
async function remove(id: string) {
  await updateMarketplaceSources(({ sources, official, tombstones }) => {
    const gone = sources.find((s) => s.id === id)!;
    return {
      sources: sources.filter((s) => s.id !== id),
      official,
      tombstones: {
        ...tombstones,
        [id]: {
          publicKey: gone.publicKey!,
          keyFingerprint: gone.keyFingerprint!,
          removedAt: NOW.toISOString(),
        },
      },
      result: null,
    };
  });
  await deleteSourceRows(id);
}

let key: FixtureKey;
let fx: ReturnType<typeof makeSource>;

beforeEach(async () => {
  await h.client!.exec(
    `delete from pod_settings; delete from cp_catalog_cache;`
  );
  key = makeKey();
  fx = makeSource({ key, packages: PACKAGES });
  await q(`insert into pod_settings (settings) values ($1::jsonb)`, [
    JSON.stringify({
      marketplaceSources: [setting(key)],
      catalogSyncStamps: { keep: { lastStatus: "ok" } },
    }),
  ]);
  // A stale listing of this source, and another source's row.
  await q(
    `insert into cp_catalog_cache (source, kind, slug, name) values
       ('acme', 'skill', 'old', 'Old'), ('other', 'cell', 'x', 'X')`
  );
});

const sync = () =>
  syncThirdPartySource(catalogSource(key), undefined, {
    fetchImpl: fx.fetchImpl,
    now: NOW,
  });

describe("replaceSourceRows on PGlite", () => {
  it("a source still pinned: exactly its signed rows, its stale row pruned, others untouched", async () => {
    expect((await sync()).state).toBe("ok");
    expect(await rows("acme")).toEqual([
      { kind: "cell", slug: "charts/bar" },
      { kind: "template", slug: "crm" },
    ]);
    expect(await rows("other")).toEqual([{ kind: "cell", slug: "x" }]);
    const s = await settings();
    expect(s.marketplaceSourceStatus).toMatchObject({
      acme: { state: "ok", packageCount: 2 },
    });
    expect(s.catalogSyncStamps).toEqual({ keep: { lastStatus: "ok" } });
  });

  it("a remove committed first: the sync writes no rows and no status", async () => {
    await remove("acme");
    await sync();
    expect(await rows("acme")).toEqual([]);
    expect((await settings()).marketplaceSourceStatus).toBeUndefined();
  });

  it("a key re-approval committed first: the sync under the old key writes nothing", async () => {
    await updateMarketplaceSources(({ sources, official }) => ({
      sources: sources.map((s) => ({ ...s, publicKey: makeKey().publicKey })),
      official,
      result: null,
    }));
    await sync();
    expect(await rows("acme")).toEqual([{ kind: "skill", slug: "old" }]);
    expect((await settings()).marketplaceSourceStatus).toBeUndefined();
  });

  it("a sync and a remove started together leave no rows and no source, in either order", async () => {
    for (const order of ["sync-first", "remove-first"] as const) {
      await h.client!.exec(
        `delete from cp_catalog_cache where source = 'acme'`
      );
      await updateMarketplaceSources(({ official }) => ({
        sources: [setting(key)],
        official,
        result: null,
      }));
      await Promise.all(
        order === "sync-first"
          ? [sync(), remove("acme")]
          : [remove("acme"), sync()]
      );
      expect(await rows("acme"), order).toEqual([]);
      const { sources } = await readMarketplaceSources();
      expect(sources, order).toEqual([]);
    }
  });
});

describe("the removed id's tombstone on PGlite", () => {
  it("is written with the remove, beside every other setting, and read back", async () => {
    await sync();
    await remove("acme");
    const snapshot = await readMarketplaceSources();
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.tombstones).toEqual({
      acme: {
        publicKey: key.publicKey,
        keyFingerprint: keyFingerprint(key.publicKey),
        removedAt: NOW.toISOString(),
      },
    });
    const s = await settings();
    expect(s.catalogSyncStamps).toEqual({ keep: { lastStatus: "ok" } });
    expect(s.marketplaceSourceStatus).toMatchObject({ acme: { state: "ok" } });
  });

  it("a write that returns no tombstones leaves them as they are", async () => {
    await remove("acme");
    await updateMarketplaceSources(({ official }) => ({
      sources: [],
      official,
      result: null,
    }));
    expect(Object.keys((await readMarketplaceSources()).tombstones)).toEqual([
      "acme",
    ]);
  });
});
