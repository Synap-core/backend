/**
 * `market.search` reads the catalog through `queryCatalogCache`; an agent
 * holds a package by its slug. Live, 2026-11-10: `market.search {query:
 * "media-ffmpeg", kind: "capability"}` returned media-download, media-matte
 * and media-transcribe (their descriptions say "needs media-ffmpeg") and NOT
 * media-ffmpeg, whose name is "ffmpeg on your computer": the ranking read the
 * name, tags and description, never the slug. Drives the real door on a real
 * `cp_catalog_cache` table.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  // An unscoped catalog read is the OFFICIAL source only
  // (`officialCatalogUrl()`): the rows below are seeded under it.
  process.env.CONTROL_PLANE_URL = "https://cp.test";
  const state = {
    client: null as null | {
      query: (sql: string, params?: unknown[]) => Promise<unknown>;
      exec: (sql: string) => Promise<unknown>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = await h.init();
  return { ...actual, db, getDb: async () => db };
});

import * as schema from "@synap/database/schema";
import type { PgTable } from "drizzle-orm/pg-core";
import { pgliteSchemaDdl } from "../../__tests__/pglite-ddl.js";
import { queryCatalogCache } from "./catalog-cache-query.js";

const q = (sql: string, params: unknown[] = []) =>
  h.client!.query(sql, params) as Promise<unknown>;

async function capability(slug: string, name: string, description: string) {
  await q(
    `insert into cp_catalog_cache (source, kind, slug, name, description) values ('https://cp.test','capability',$1,$2,$3)`,
    [slug, name, description]
  );
}

beforeAll(async () => {
  await h.init();
  const s = schema as unknown as Record<string, PgTable>;
  await h.client!.exec(pgliteSchemaDdl([s.cpCatalogCache!]));
  // The live catalog's four media capabilities, as the CP lists them.
  await capability(
    "media-download",
    "Download videos on your computer",
    "yt-dlp installed with uv. Needs media-ffmpeg to merge video and audio."
  );
  await capability(
    "media-matte",
    "Remove a video's background on your computer",
    "A person matte. Composite with media-ffmpeg's background-replace recipe."
  );
  await capability(
    "media-ffmpeg",
    "ffmpeg on your computer",
    "ffmpeg with libass, plus the recipe library (spec.recipes)."
  );
  await capability(
    "media-transcribe",
    "Transcribe on your computer",
    "Local speech-to-text. Needs media-ffmpeg to turn a video into audio first."
  );
});

describe("queryCatalogCache — a package is found by its slug", () => {
  it("market.search's slug query returns the package itself, first", async () => {
    const entries = await queryCatalogCache({
      query: "media-ffmpeg",
      kind: "capability",
    });
    expect(entries.map((e) => e.slug)).toContain("media-ffmpeg");
    expect(entries[0]!.slug).toBe("media-ffmpeg");
  });

  it("a slug that no name or description says still finds its package", async () => {
    // "media-transcribe" appears in no row's text: only its slug carries it.
    const entries = await queryCatalogCache({ query: "media-transcribe" });
    expect(entries.map((e) => e.slug)).toEqual(["media-transcribe"]);
  });

  it("CONTROL: a name query still ranks by name", async () => {
    const entries = await queryCatalogCache({ query: "transcribe" });
    expect(entries[0]!.slug).toBe("media-transcribe");
  });
});
