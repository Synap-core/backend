/**
 * REAL-POSTGRES (PGlite) test for migration 0377 — `publish_post.media` is
 * marked as pod files (`"x-synap-pod-file": true`):
 *  - on top of 0368's seeded shape, the marker lands on `media` and nothing
 *    else in the shape changes;
 *  - idempotent (applied twice);
 *  - an edited shape with no `media` is left as it is (never re-adds a field);
 *  - another intent is untouched.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const SEED = read("0368_intent_input_schema.sql");
const MIGRATION = read("0377_publish_post_media_pod_files.sql");

type Shape = { properties: Record<string, Record<string, unknown>> };
let pg: PGlite;
const shapeOf = async (slug: string) =>
  (
    await pg.query<{ s: Shape | null }>(
      `SELECT input_schema AS s FROM capability_intents WHERE slug = $1`,
      [slug]
    )
  ).rows[0]!.s;

let seeded: Shape;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE capability_intents (slug text PRIMARY KEY, effect text);
    CREATE TABLE skills (id uuid PRIMARY KEY);
    INSERT INTO capability_intents (slug, effect) VALUES ('publish_post', 'write'), ('send_message', 'write');
  `);
  await pg.exec(SEED);
  seeded = (await shapeOf("publish_post"))!;
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

describe("0377 publish_post.media is pod files", () => {
  it("marks media, and changes nothing else in the shape", async () => {
    const after = (await shapeOf("publish_post"))!;
    expect(seeded.properties.media).toBeDefined();
    expect(seeded.properties.media!["x-synap-pod-file"]).toBeUndefined();
    expect(after.properties.media).toEqual({
      ...seeded.properties.media,
      "x-synap-pod-file": true,
    });
    const { media: _a, ...restAfter } = after.properties;
    const { media: _b, ...restSeeded } = seeded.properties;
    expect(restAfter).toEqual(restSeeded);
  });

  it("leaves an edited shape with no media as it is", async () => {
    const edited = { type: "object", properties: { text: { type: "string" } } };
    await pg.query(
      `UPDATE capability_intents SET input_schema = $1::jsonb WHERE slug = 'publish_post'`,
      [JSON.stringify(edited)]
    );
    await pg.exec(MIGRATION);
    expect(await shapeOf("publish_post")).toEqual(edited);
  });

  it("touches no other intent", async () => {
    expect(await shapeOf("send_message")).toBeNull();
  });
});
