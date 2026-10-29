/**
 * REAL-POSTGRES (PGlite) test for migration 0370 — the edit_video intent
 * (founder decision ac1ba2b6, 2026-10-28). Each case rules out one wrong
 * migration:
 *  - the row classified `read` (an app's run of it would then skip review:
 *    `appRunMustPropose` proposes only a non-read effect);
 *  - a shape that lets an app send more than the video, a non-https URL, or
 *    nothing at all;
 *  - a second run, or a pod whose shape was already edited, overwritten;
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
const MIGRATION = read("0370_edit_video_intent.sql");

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // The table as 0283 + 0368 leave it, constraints included.
  await pg.exec(`
    CREATE TABLE capability_intents (
      slug text PRIMARY KEY, effect text NOT NULL, statement text NOT NULL,
      synonyms text[] NOT NULL DEFAULT '{}',
      input_schema jsonb,
      CONSTRAINT capability_intents_effect_check CHECK (effect IN ('read', 'write', 'act')),
      CONSTRAINT capability_intents_slug_check CHECK (slug ~ '^[a-z][a-z0-9_]{0,63}$')
    );
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

const row = async () =>
  (
    await pg.query<{
      effect: string;
      input_schema: {
        properties: Record<string, Record<string, unknown>>;
        required: string[];
        additionalProperties: boolean;
      } | null;
    }>(`SELECT effect, input_schema FROM capability_intents WHERE slug = $1`, [
      "edit_video",
    ])
  ).rows;

describe("0370 edit_video intent", () => {
  it("inserts one row, with an effect that reaches outside the pod", async () => {
    const rows = await row();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effect).toBe("act");
  });

  it("its one input is an https URL of the video, required, nothing else", async () => {
    const s = (await row())[0]!.input_schema!;
    expect(Object.keys(s.properties)).toEqual(["video"]);
    expect(s.required).toEqual(["video"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.video).toMatchObject({
      type: "string",
      format: "uri",
      pattern: "^https://",
      maxLength: 2048,
    });
  });

  it("never overwrites a shape a pod already set", async () => {
    await pg.query(
      `UPDATE capability_intents SET input_schema = '{"type":"object"}'::jsonb WHERE slug = 'edit_video'`
    );
    await pg.exec(MIGRATION);
    expect((await row())[0]!.input_schema).toEqual({ type: "object" });
  });
});
