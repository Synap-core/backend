/**
 * REAL-POSTGRES (PGlite) test for migration 0413 — transcribe_media and
 * download_media, and edit_video's ffmpeg words. Each case rules out one
 * wrong migration:
 *  - a row classified `read` (an app's run of it would skip review);
 *  - a second run duplicating edit_video's synonyms, or dropping one a pod
 *    already had;
 *  - a row a pod already edited overwritten;
 *  - a slug the table's own CHECK constraints refuse.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const MIGRATION = read("0413_media_intents.sql");

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // The table as 0283 + 0368 leave it, constraints included, and edit_video
  // as 0370 seeds it plus one synonym a pod added itself.
  await pg.exec(`
    CREATE TABLE capability_intents (
      slug text PRIMARY KEY, effect text NOT NULL, statement text NOT NULL,
      synonyms text[] NOT NULL DEFAULT '{}',
      input_schema jsonb,
      CONSTRAINT capability_intents_effect_check CHECK (effect IN ('read', 'write', 'act')),
      CONSTRAINT capability_intents_slug_check CHECK (slug ~ '^[a-z][a-z0-9_]{0,63}$')
    );
  `);
  await pg.exec(read("0370_edit_video_intent.sql"));
  await pg.exec(
    `UPDATE capability_intents SET synonyms = synonyms || ARRAY['my own word', 'shorts'] WHERE slug = 'edit_video'`
  );
  await pg.exec(
    `INSERT INTO capability_intents (slug, effect, statement) VALUES ('download_media', 'act', 'edited on this pod')`
  );
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

const rowOf = async (slug: string) =>
  (
    await pg.query<{
      effect: string;
      statement: string;
      synonyms: string[];
      input_schema: unknown;
    }>(
      `SELECT effect, statement, synonyms, input_schema FROM capability_intents WHERE slug = $1`,
      [slug]
    )
  ).rows;

describe("0413 media intents", () => {
  it("adds transcribe_media as work that reaches outside the pod, with no app input yet", async () => {
    const rows = await rowOf("transcribe_media");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effect).toBe("act");
    expect(rows[0]!.synonyms).toContain("transcript");
    expect(rows[0]!.input_schema).toBeNull();
  });

  it("never overwrites a row a pod already has", async () => {
    const rows = await rowOf("download_media");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.statement).toBe("edited on this pod");
  });

  it("appends edit_video's ffmpeg words once, keeping the pod's own", async () => {
    const [row] = await rowOf("edit_video");
    expect(row!.synonyms).toContain("my own word");
    expect(row!.synonyms).toContain("cut a clip");
    expect(row!.synonyms).toContain("reframe to vertical");
    // 0370's own, still there.
    expect(row!.synonyms).toContain("remove background");
    // Two runs, and a word the pod already had: each appears once.
    expect(row!.synonyms.filter((s) => s === "cut a clip")).toHaveLength(1);
    expect(row!.synonyms.filter((s) => s === "shorts")).toHaveLength(1);
  });

  it("every slug it inserts passes the table's own slug check", async () => {
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM capability_intents WHERE slug IN ('transcribe_media', 'download_media')`
    );
    expect(rows[0]!.n).toBe(2);
  });
});
