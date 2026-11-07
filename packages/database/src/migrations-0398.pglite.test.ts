/**
 * REAL-POSTGRES (PGlite) test for migration 0398 — intent contracts and the
 * reachability intents (plan U1, document 64072312). Each case rules out one
 * wrong migration:
 *  - SQL a pod cannot run (a quote or a cast in a JSON literal), or a second
 *    run that fails or duplicates;
 *  - a slug the table's own CHECK constraints refuse (a dot, as in
 *    `expose.http`);
 *  - the outward intents classified `read` (an app's run would skip review:
 *    `appRunMustPropose` proposes only a non-read effect);
 *  - a shape or contract a pod already edited, overwritten;
 *  - a skill row that cannot record which op it implements.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, "../migrations/0398_reachability_intents.sql"),
  "utf8"
);

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  // The tables as 0283 + 0368 leave them (skills reduced to what 0398 reads).
  await pg.exec(`
    CREATE TABLE capability_intents (
      slug text PRIMARY KEY, effect text NOT NULL, statement text NOT NULL,
      synonyms text[] NOT NULL DEFAULT '{}',
      input_schema jsonb,
      CONSTRAINT capability_intents_effect_check CHECK (effect IN ('read', 'write', 'act')),
      CONSTRAINT capability_intents_slug_check CHECK (slug ~ '^[a-z][a-z0-9_]{0,63}$')
    );
    CREATE TABLE skills (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      intent text, input_map jsonb,
      execution_mode text NOT NULL DEFAULT 'sync'
    );
  `);
  await pg.exec(MIGRATION);
  await pg.exec(MIGRATION); // idempotent
});

type Row = {
  slug: string;
  effect: string;
  input_schema: Record<string, unknown> | null;
  contract: { version: number; ops: Record<string, unknown> } | null;
};
const rows = async () =>
  (
    await pg.query<Row>(
      `SELECT slug, effect, input_schema, contract FROM capability_intents ORDER BY slug`
    )
  ).rows;

describe("0398 intent contracts", () => {
  it("inserts the five rows once, each with an input and a contract", async () => {
    const all = await rows();
    expect(all.map((r) => r.slug)).toEqual([
      "dns_record",
      "expose_http",
      "host_service",
      "open_tunnel",
      "render_video",
    ]);
    for (const r of all) {
      expect(r.input_schema, r.slug).toMatchObject({ type: "object" });
      expect(r.contract, r.slug).toMatchObject({ version: 1 });
      expect(Object.keys(r.contract!.ops), r.slug).toContain("create");
    }
  });

  it("the outward intents are act; render_video files into the pod (write)", async () => {
    const effect = Object.fromEntries(
      (await rows()).map((r) => [r.slug, r.effect])
    );
    expect(effect).toEqual({
      dns_record: "act",
      expose_http: "act",
      host_service: "act",
      open_tunnel: "act",
      render_video: "write",
    });
  });

  it("keeps the regex patterns intact through the SQL literal", async () => {
    const [r] = (await rows()).filter((x) => x.slug === "dns_record");
    const zone = (
      r!.input_schema!.properties as Record<string, { pattern: string }>
    ).zone!.pattern;
    expect(new RegExp(zone).test("synap.live")).toBe(true);
    expect(new RegExp(zone).test("synap..live")).toBe(false);
  });

  it("never overwrites a shape or a contract a pod already set", async () => {
    await pg.query(
      `UPDATE capability_intents
         SET input_schema = '{"type":"object"}'::jsonb,
             contract = '{"version":1,"edited":true}'::jsonb
       WHERE slug = 'expose_http'`
    );
    await pg.exec(MIGRATION);
    const [r] = (await rows()).filter((x) => x.slug === "expose_http");
    expect(r!.input_schema).toEqual({ type: "object" });
    expect(r!.contract).toEqual({ version: 1, edited: true });
  });

  it("a skill records the op it implements, and may be hosted", async () => {
    await pg.query(
      `INSERT INTO skills (intent, intent_op, execution_mode) VALUES ('expose_http', 'revoke', 'hosted')`
    );
    const r = await pg.query<{ intent_op: string; execution_mode: string }>(
      `SELECT intent_op, execution_mode FROM skills WHERE intent = 'expose_http'`
    );
    expect(r.rows).toEqual([{ intent_op: "revoke", execution_mode: "hosted" }]);
  });
});
