/**
 * REAL-POSTGRES (PGlite) test for `connectionServesVerb` — the check that keeps
 * an automation's trigger-level `connectionId` from being forced onto a step of
 * ANOTHER capability.
 *
 * Scenario: one automation, trigger connection = a Google connection, two
 * capability steps — a Google verb and a Slack verb. Only the Google step may
 * receive the trigger connection; the Slack step must keep its default binding
 * (the dispatcher throws on a foreign-capability selector).
 *
 * Real SQL on purpose: the join crosses `links.from_id` (text) and `tools.id`
 * (uuid) and filters the jsonb verb catalog with `@>` — neither is visible to a
 * mocked db. Minimal DDL for the three tables the helper reads.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  connectionServesVerb,
  resolveCapabilityConnectionSelector,
} from "./command-skill-capability.js";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let database: any;

const GOOGLE_CAP = "aaaaaaaa-0000-4000-8000-000000000001";
const SLACK_CAP = "aaaaaaaa-0000-4000-8000-000000000002";
const GOOGLE_TOOL = "bbbbbbbb-0000-4000-8000-000000000001";
const SLACK_TOOL = "bbbbbbbb-0000-4000-8000-000000000002";
const GOOGLE_CONN = "cccccccc-0000-4000-8000-000000000001";
const DELETED_CONN = "cccccccc-0000-4000-8000-000000000002";
const PLAIN_SECRET = "cccccccc-0000-4000-8000-000000000003";

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE secrets (
      id uuid PRIMARY KEY,
      capability_id uuid,
      deleted_at timestamptz
    );
    CREATE TABLE tools (
      id uuid PRIMARY KEY,
      capabilities jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE links (
      id serial PRIMARY KEY,
      from_type text NOT NULL,
      from_id text NOT NULL,
      to_type text NOT NULL,
      to_id text NOT NULL,
      link_type text NOT NULL
    );
    INSERT INTO tools (id, capabilities) VALUES
      ('${GOOGLE_TOOL}', '[{"id":"calendar_list","kind":"read"},{"id":"gmail_list_threads","kind":"read"}]'),
      ('${SLACK_TOOL}',  '[{"id":"slack_post_message","kind":"write"}]');
    INSERT INTO links (from_type, from_id, to_type, to_id, link_type) VALUES
      ('tool', '${GOOGLE_TOOL}', 'capability', '${GOOGLE_CAP}', 'member_of'),
      ('tool', '${SLACK_TOOL}',  'capability', '${SLACK_CAP}',  'member_of');
    INSERT INTO secrets (id, capability_id, deleted_at) VALUES
      ('${GOOGLE_CONN}',  '${GOOGLE_CAP}', NULL),
      ('${DELETED_CONN}', '${GOOGLE_CAP}', now()),
      ('${PLAIN_SECRET}', NULL, NULL);
  `);
  database = drizzle(pg);
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

describe("connectionServesVerb — multi-capability automation", () => {
  it("the Google trigger connection serves the Google step's verb", async () => {
    await expect(
      connectionServesVerb(GOOGLE_CONN, "calendar_list", database)
    ).resolves.toBe(true);
  });

  it("the Google trigger connection does NOT serve the Slack step's verb", async () => {
    await expect(
      connectionServesVerb(GOOGLE_CONN, "slack_post_message", database)
    ).resolves.toBe(false);
  });

  it("end to end: the Google step gets the selector, the Slack step keeps its default binding", async () => {
    const forStep = async (verbId: string) =>
      resolveCapabilityConnectionSelector(
        {},
        {
          connectionId: GOOGLE_CONN,
          servesThisVerb: await connectionServesVerb(
            GOOGLE_CONN,
            verbId,
            database
          ),
        }
      );
    await expect(forStep("gmail_list_threads")).resolves.toEqual({
      connectionId: GOOGLE_CONN,
    });
    await expect(forStep("slack_post_message")).resolves.toBeNull();
  });

  it("a deleted connection, a non-capability secret, or an unknown id serves nothing", async () => {
    await expect(
      connectionServesVerb(DELETED_CONN, "calendar_list", database)
    ).resolves.toBe(false);
    await expect(
      connectionServesVerb(PLAIN_SECRET, "calendar_list", database)
    ).resolves.toBe(false);
    await expect(
      connectionServesVerb(
        "cccccccc-0000-4000-8000-00000000ffff",
        "calendar_list",
        database
      )
    ).resolves.toBe(false);
  });
});
