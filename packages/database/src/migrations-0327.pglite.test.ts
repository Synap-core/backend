/**
 * REAL-POSTGRES (PGlite) test for migration 0327 — the `source` split
 * (decision 2026-09-14): the global `source` def is free text again, a
 * profile's CRM lead-source def becomes `leadSource`, lead attribution values
 * move to `leadSource`, transport values to `provenance`, provider names stay.
 * Runs the migration TWICE: the second pass must change nothing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0327 = readFileSync(
  resolve(HERE, "../migrations/0327_split_source_provenance_lead_source.sql"),
  "utf8"
);

const LEAD_ENUM = `["cold-outreach","linkedin","referral","other"]`;
const P_LEAD = "00000000-0000-4000-8000-0000000000a1";
const P_PERSON = "00000000-0000-4000-8000-0000000000a2";
const P_COMPANY = "00000000-0000-4000-8000-0000000000a3";

let pg: PGlite;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = async <T = any>(sql: string) => (await pg.query<T>(sql)).rows;

const props = async (title: string) =>
  (
    await q<{ properties: Record<string, unknown> }>(
      `SELECT properties FROM entities WHERE title = '${title}'`
    )
  )[0]!.properties;

const def = async (where: string) =>
  q<{
    slug: string;
    constraints: Record<string, unknown>;
    ui_hints: Record<string, unknown>;
  }>(`SELECT slug, constraints, ui_hints FROM property_defs WHERE ${where}`);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE profiles (id uuid PRIMARY KEY, slug text NOT NULL);
    CREATE TABLE property_defs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL,
      profile_id uuid,
      workspace_id uuid,
      constraints jsonb NOT NULL DEFAULT '{}',
      ui_hints jsonb NOT NULL DEFAULT '{}',
      updated_at timestamptz
    );
    CREATE TABLE entities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL,
      title text,
      properties jsonb NOT NULL DEFAULT '{}',
      deleted_at timestamptz,
      updated_at timestamptz
    );
    CREATE TABLE entity_facets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id uuid,
      profile_id uuid NOT NULL,
      properties jsonb NOT NULL DEFAULT '{}',
      deleted_at timestamptz,
      updated_at timestamptz
    );
    INSERT INTO profiles VALUES
      ('${P_LEAD}', 'lead'), ('${P_PERSON}', 'person'), ('${P_COMPANY}', 'company');

    -- The live-pod state: the CRM lead enum unioned into the GLOBAL def.
    INSERT INTO property_defs (slug, constraints, ui_hints) VALUES
      ('source', '{"enum": ${LEAD_ENUM}}',
       '{"label": "Source", "inputType": "select", "enumValues": ["manual"]}');
    -- CRM's own lead-source defs: an overlay on person, a base on lead.
    INSERT INTO property_defs (slug, profile_id, workspace_id, constraints, ui_hints) VALUES
      ('source', '${P_PERSON}', gen_random_uuid(), '{"enum": ${LEAD_ENUM}}', '{"label": "Source", "inputType": "select"}'),
      ('source', '${P_LEAD}', NULL, '{"enum": ${LEAD_ENUM}}', '{"label": "Source", "inputType": "select"}');
    -- A company base def whose scope ALREADY has leadSource (step 3).
    INSERT INTO property_defs (slug, profile_id, constraints) VALUES
      ('source', '${P_COMPANY}', '{"enum": ${LEAD_ENUM}}'),
      ('leadSource', '${P_COMPANY}', '{"enum": ${LEAD_ENUM}}');
    -- A domain-specific 'source' on another kind (HR candidate) is NOT lead.
    INSERT INTO property_defs (slug, profile_id, constraints) VALUES
      ('source', gen_random_uuid(), '{"enum": ["referral","agency"]}');

    INSERT INTO entities (type, title, properties) VALUES
      ('person',   'lead-person',     '{"source": "referral"}'),
      ('person',   'lead-person-set', '{"source": "linkedin", "leadSource": "event"}'),
      ('person',   'met-on-call',     '{"source": "fireflies"}'),
      ('company',  'imported-co',     '{"source": "import"}'),
      ('bookmark', 'fal-image',       '{"source": "fal.ai"}'),
      ('bookmark', 'manual-link',     '{"source": "manual"}'),
      ('bookmark', 'referral-link',   '{"source": "referral"}'),
      ('quote',    'a-quote',         '{"source": "manual"}');
    INSERT INTO entity_facets (profile_id, properties) VALUES
      ('${P_LEAD}', '{"source": "cold-outreach", "icpScore": 3}');
  `);
  await pg.exec(M0327);
}, 120_000);

describe("migration 0327 — split source into provenance + leadSource", () => {
  it("the global `source` def is free text again", async () => {
    const [g] = await def(
      `slug = 'source' AND profile_id IS NULL AND workspace_id IS NULL`
    );
    expect(g!.constraints).toEqual({});
    expect(g!.ui_hints).toEqual({ label: "Source", inputType: "text" });
  });

  it("a profile's CRM lead-source def is renamed to leadSource", async () => {
    for (const p of [P_PERSON, P_LEAD]) {
      const rows = await def(`profile_id = '${p}'`);
      expect(rows.map((r) => r.slug)).toEqual(["leadSource"]);
      expect(rows[0]!.ui_hints.label).toBe("Lead source");
      expect(rows[0]!.constraints.enum).toContain("cold-outreach");
    }
  });

  it("where leadSource already exists, the stale source def only loses its enum", async () => {
    const rows = await def(`profile_id = '${P_COMPANY}' ORDER BY slug`);
    expect(rows.map((r) => [r.slug, r.constraints])).toEqual([
      ["leadSource", { enum: JSON.parse(LEAD_ENUM) }],
      ["source", {}],
    ]);
  });

  it("another kind's own `source` vocabulary is left alone", async () => {
    const [hr] = await def(`slug = 'source' AND constraints ? 'enum'`);
    expect(hr!.constraints.enum).toEqual(["referral", "agency"]);
  });

  it("moves lead attribution on CRM kinds to leadSource (existing wins)", async () => {
    expect(await props("lead-person")).toEqual({ leadSource: "referral" });
    expect(await props("lead-person-set")).toEqual({
      source: "linkedin",
      leadSource: "event",
    });
    const [facet] = await q<{ properties: Record<string, unknown> }>(
      `SELECT properties FROM entity_facets`
    );
    expect(facet!.properties).toEqual({
      leadSource: "cold-outreach",
      icpScore: 3,
    });
  });

  it("moves transport values to provenance on capturable kinds only", async () => {
    expect(await props("imported-co")).toEqual({ provenance: "import" });
    expect(await props("manual-link")).toEqual({ provenance: "manual" });
    expect(await props("a-quote")).toEqual({ source: "manual" });
  });

  it("leaves provider names, and lead words off CRM kinds, in legacy source", async () => {
    expect(await props("fal-image")).toEqual({ source: "fal.ai" });
    expect(await props("met-on-call")).toEqual({ source: "fireflies" });
    expect(await props("referral-link")).toEqual({ source: "referral" });
  });

  it("is idempotent: a second run changes nothing", async () => {
    const snap = async () =>
      JSON.stringify([
        await q(
          `SELECT slug, profile_id, constraints, ui_hints FROM property_defs ORDER BY slug, profile_id NULLS FIRST, constraints::text`
        ),
        await q(`SELECT title, properties FROM entities ORDER BY title`),
        await q(`SELECT properties FROM entity_facets`),
      ]);
    const before = await snap();
    await pg.exec(M0327);
    expect(await snap()).toBe(before);
  });
});
