/**
 * REAL-POSTGRES (PGlite) test for migration 0410 — one input for
 * enrich_entity (CRM "Find their LinkedIn" runs the lookup tool, no AI):
 *  - enrich_entity is seeded `{ name, company? }`, name required, nothing else;
 *  - a shape a pod already set is kept, other intents are untouched, and a
 *    second run changes nothing (idempotent).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../migrations/0410_intent_input_enrich_entity.sql"),
  "utf8"
);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE capability_intents (
      slug text PRIMARY KEY, effect text NOT NULL, statement text NOT NULL,
      synonyms text[] NOT NULL DEFAULT '{}', input_schema jsonb
    );
    INSERT INTO capability_intents (slug, effect, statement, input_schema) VALUES
      ('enrich_entity', 'read', 'Add known facts', NULL),
      ('find_people', 'read', 'Locate people', NULL),
      ('request_connection', 'act', 'Ask to connect', '{"type":"object","x":1}'::jsonb);
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

type Shape = {
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: boolean;
};
const schemaOf = async (slug: string) =>
  (
    await pg.query<{ input_schema: Shape | null }>(
      `SELECT input_schema FROM capability_intents WHERE slug = $1`,
      [slug]
    )
  ).rows[0]?.input_schema ?? null;

describe("0410 one input for enrich_entity", () => {
  it("enrich_entity takes { name, company? }: only name required, nothing else", async () => {
    const s = (await schemaOf("enrich_entity"))!;
    expect(Object.keys(s.properties).sort()).toEqual(["company", "name"]);
    expect(s.required).toEqual(["name"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.name).toMatchObject({ type: "string", minLength: 1 });
    expect(s.properties.company).toMatchObject({
      type: "string",
      minLength: 1,
    });
  });

  it("leaves the other intents as they were", async () => {
    expect(await schemaOf("find_people")).toBeNull();
    expect(await schemaOf("request_connection")).toEqual({
      type: "object",
      x: 1,
    });
  });

  it("never overwrites a shape a pod already set", async () => {
    await pg.query(
      `UPDATE capability_intents SET input_schema = '{"type":"object"}'::jsonb WHERE slug = 'enrich_entity'`
    );
    await pg.exec(MIGRATION);
    expect(await schemaOf("enrich_entity")).toEqual({ type: "object" });
  });
});
