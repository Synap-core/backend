/**
 * REAL-POSTGRES (PGlite) test for migration 0368 — one input per intent
 * (intent actions, decision 5B, 2026-10-28):
 *  - `capability_intents.input_schema` and `skills.input_map` land, and a
 *    second run changes nothing (idempotent);
 *  - `publish_post` is seeded with its one input `{ text, media?, link?,
 *    when? }`, `text` required; a shape a pod already edited is kept;
 *  - the Drizzle schema declares both columns, the fresh-DB baseline carries
 *    the same DDL, and the boot coherence list names them, attributed to 0368.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { capabilityIntents } from "./schema/capability-intents.js";
import { skills } from "./schema/skills.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const FILE = "0368_intent_input_schema.sql";
const MIGRATION = read(FILE);
const BASELINE = read("0000_baseline_schema.sql");

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE capability_intents (
      slug text PRIMARY KEY, effect text NOT NULL, statement text NOT NULL,
      synonyms text[] NOT NULL DEFAULT '{}'
    );
    CREATE TABLE skills (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
    INSERT INTO capability_intents (slug, effect, statement) VALUES
      ('publish_post', 'write', 'Broadcast a post'),
      ('send_message', 'write', 'Deliver a message');
    INSERT INTO skills (name) VALUES ('postiz_schedule');
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

const schemaOf = async (slug: string) =>
  (
    await pg.query<{ input_schema: Record<string, unknown> | null }>(
      `SELECT input_schema FROM capability_intents WHERE slug = $1`,
      [slug]
    )
  ).rows[0]?.input_schema ?? null;

describe("0368 one input per intent", () => {
  it("seeds publish_post's one input, text required, nothing else open", async () => {
    const s = (await schemaOf("publish_post")) as {
      properties: Record<string, { type: string }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(s.properties).sort()).toEqual([
      "link",
      "media",
      "text",
      "when",
    ]);
    expect(s.required).toEqual(["text"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.text).toMatchObject({
      type: "string",
      maxLength: 3000,
    });
    expect(s.properties.link).toMatchObject({ pattern: "^https://" });
    expect(s.properties.when).toMatchObject({ format: "date-time" });
  });

  it("leaves every other intent without one (apps cannot ask for it yet)", async () => {
    expect(await schemaOf("send_message")).toBeNull();
  });

  it("never overwrites a shape a pod already set", async () => {
    await pg.query(
      `UPDATE capability_intents SET input_schema = '{"type":"object"}'::jsonb WHERE slug = 'publish_post'`
    );
    await pg.exec(MIGRATION);
    expect(await schemaOf("publish_post")).toEqual({ type: "object" });
  });

  it("existing skills keep a NULL map (no verb is offered until its template maps it)", async () => {
    const r = await pg.query<{ input_map: unknown }>(
      `SELECT input_map FROM skills`
    );
    expect(r.rows).toEqual([{ input_map: null }]);
  });

  it("the drizzle schema, the baseline and the boot check agree", () => {
    expect(
      getTableConfig(capabilityIntents).columns.map((c) => c.name)
    ).toContain("input_schema");
    expect(getTableConfig(skills).columns.map((c) => c.name)).toContain(
      "input_map"
    );
    expect(BASELINE).toContain(
      'ALTER TABLE "capability_intents" ADD COLUMN IF NOT EXISTS "input_schema" jsonb;'
    );
    expect(BASELINE).toContain(
      'ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "input_map" jsonb;'
    );
    for (const [table, column] of [
      ["capability_intents", "input_schema"],
      ["skills", "input_map"],
    ])
      expect(REQUIRED_COLUMNS).toContainEqual({ table, column, addedBy: FILE });
  });
});
