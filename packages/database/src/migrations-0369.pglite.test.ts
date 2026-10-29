/**
 * REAL-POSTGRES (PGlite) test for migration 0369 — one input for
 * send_message and request_connection (CRM consolidation plan, Lane 2):
 *  - send_message is seeded `{ to, text, subject? }`, to and text required;
 *  - request_connection is seeded `{ to, text? }`, to required, the note short;
 *  - `to` is an entity id (uuid), never an address: the pod resolves it;
 *  - a shape a pod already set is kept, publish_post is untouched, and a
 *    second run changes nothing (idempotent).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../migrations/0369_intent_input_send_message.sql"),
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
      ('send_message', 'act', 'Deliver a message', NULL),
      ('request_connection', 'act', 'Ask to connect', NULL),
      ('publish_post', 'write', 'Broadcast a post', '{"type":"object","x":1}'::jsonb);
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

describe("0369 one input for send_message and request_connection", () => {
  it("send_message takes { to, text, subject? }: to and text required, nothing else", async () => {
    const s = (await schemaOf("send_message"))!;
    expect(Object.keys(s.properties).sort()).toEqual(["subject", "text", "to"]);
    expect(s.required.sort()).toEqual(["text", "to"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.to).toMatchObject({ type: "string", format: "uuid" });
    expect(s.properties.text).toMatchObject({ type: "string", minLength: 1 });
  });

  it("request_connection takes { to, text? }: only to required, a short note", async () => {
    const s = (await schemaOf("request_connection"))!;
    expect(Object.keys(s.properties).sort()).toEqual(["text", "to"]);
    expect(s.required).toEqual(["to"]);
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.to).toMatchObject({ type: "string", format: "uuid" });
    expect(s.properties.text).toMatchObject({ maxLength: 300 });
  });

  it("leaves publish_post as it was", async () => {
    expect(await schemaOf("publish_post")).toEqual({ type: "object", x: 1 });
  });

  it("never overwrites a shape a pod already set", async () => {
    await pg.query(
      `UPDATE capability_intents SET input_schema = '{"type":"object"}'::jsonb WHERE slug = 'send_message'`
    );
    await pg.exec(MIGRATION);
    expect(await schemaOf("send_message")).toEqual({ type: "object" });
  });
});
