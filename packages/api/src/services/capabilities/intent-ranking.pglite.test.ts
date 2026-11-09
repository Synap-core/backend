/**
 * The video phrasings of audit 732371eb §4 that ask for a TOOL, ranked over
 * the intent registry a pod is actually seeded with: every intent migration
 * run on real Postgres (PGlite), the rows read back, then the ONE ranker
 * `findByIntent` uses (`rankIntentRows`).
 *
 * Before: the ranker read only the slug, and no media intent existed, so
 * "transcribe this video" and "download this YouTube video" reached no intent
 * that does the work (finding 9463e6b3). What each case rules out, measured
 * by reverting one fix at a time:
 *  - the synonyms not ranked (slug only): transcribe, subtitles, download,
 *    shorts and the two phrasings with no "video" in them fail;
 *  - 0413 not run: transcribe, subtitles and download fail.
 * The audit's "remove my background from my video" and "resize my video to
 * vertical" pass on the slug alone ("video" is in `edit_video`): they guard
 * the route, not the synonyms. The last two phrasings are ours, not the
 * audit's: the same asks without the word "video".
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

import { rankIntentRows } from "./intent-ranking.js";
import type { IntentRow } from "./intent-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/services/capabilities → src → api → packages
const MIGRATIONS = resolve(HERE, "../../../../database/migrations");
/**
 * Every migration that seeds a `capability_intents` row, DERIVED (a new intent
 * migration joins by existing), in file order: 0283 creates the table, each
 * later one inserts or extends rows. Only those files run: 0368 (which adds
 * `input_schema`) also alters `skills`, so its one column is added by hand.
 */
const INTENT_MIGRATIONS = readdirSync(MIGRATIONS)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .filter((f) =>
    readFileSync(resolve(MIGRATIONS, f), "utf8").includes(
      'INSERT INTO "capability_intents"'
    )
  )
  .sort();

let rows: IntentRow[] = [];

beforeAll(async () => {
  const pg = new PGlite();
  for (const file of INTENT_MIGRATIONS) {
    await pg.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
    if (file.startsWith("0283_"))
      await pg.exec(
        `ALTER TABLE capability_intents ADD COLUMN IF NOT EXISTS input_schema jsonb`
      );
  }
  const read = await pg.query<IntentRow>(
    `SELECT slug, statement, synonyms FROM capability_intents ORDER BY slug`
  );
  rows = read.rows;
  await pg.close();
});

const top = (query: string) => rankIntentRows(query, rows)[0];

describe("the video tool phrasings land on the intent that does the work", () => {
  it("reads the seeded registry (non-vacuity)", () => {
    expect(INTENT_MIGRATIONS[0]).toBe("0283_capability_intents.sql");
    expect(INTENT_MIGRATIONS).toContain("0413_media_intents.sql");
    expect(INTENT_MIGRATIONS.length).toBeGreaterThanOrEqual(7);
    expect(rows.map((r) => r.slug)).toEqual(
      expect.arrayContaining([
        "generate_media",
        "edit_video",
        "transcribe_media",
        "download_media",
      ])
    );
  });

  it.each([
    ["transcribe this video", "transcribe_media"],
    ["add subtitles to my video", "transcribe_media"],
    ["download this YouTube video", "download_media"],
    ["remove my background from my video", "edit_video"],
    ["resize my video to vertical for instagram", "edit_video"],
    ["cut my podcast into shorts", "edit_video"],
    ["remove the background behind me", "edit_video"],
    ["make my clip vertical for reels", "edit_video"],
  ])("%s → %s, ahead of every other intent", (query, intent) => {
    const ranked = rankIntentRows(query, rows);
    expect(ranked[0]?.item.slug).toBe(intent);
    // Strictly ahead: a tie with the runner-up is not a route.
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("says which of the row's words carried it", () => {
    expect(top("remove my background")!.match.fields).toContain("synonyms");
  });
});
