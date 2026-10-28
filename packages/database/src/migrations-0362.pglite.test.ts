/**
 * REAL-POSTGRES (PGlite) test for migration 0362 — a webhook row says which
 * way it points (`direction`), and an INBOUND source has no url.
 *
 * A pod that booted before 0362 keeps its rows as `outbound` with their url;
 * a fresh install gets the same shape from the baseline. The CHECK pins the
 * two directions and refuses an outbound row with no url (the delivery
 * producers would POST nowhere); the partial unique index keeps ONE inbound
 * source per (space, name), case-insensitive — what an automation's declared
 * `webhookSource.name` binds to.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { webhookSubscriptions } from "./schema/webhook_subscriptions.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0362 = readFileSync(
  resolve(HERE, "../migrations/0362_webhook_subscriptions_direction.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);
/** The baseline's own webhook block (CREATE + its guards). */
const BASELINE_HOOKS = BASELINE.slice(
  BASELINE.indexOf("-- ─── 51. webhook_subscriptions"),
  BASELINE.indexOf("-- Reactions projection: webhook delivery fan-out")
);
/** The table as 0335 left it: url NOT NULL, no direction. */
const PRE_0362 = `
  CREATE TABLE "webhook_subscriptions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" text NOT NULL,
    "name" text NOT NULL,
    "url" text NOT NULL,
    "event_types" text[] NOT NULL,
    "secret" text NOT NULL,
    "active" boolean NOT NULL DEFAULT true,
    "retry_config" jsonb DEFAULT '{"maxRetries":3}',
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "last_triggered_at" timestamp with time zone,
    "workspace_id" uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    "api_key_id" uuid REFERENCES "api_keys"("id") ON DELETE CASCADE
  );`;
const REFERENCED = `
  CREATE TABLE workspaces (id uuid PRIMARY KEY);
  CREATE TABLE api_keys (id uuid PRIMARY KEY);
`;
const WS1 = "00000000-0000-4000-8000-000000000001";
const WS2 = "00000000-0000-4000-8000-000000000002";

const insert = (
  pg: PGlite,
  row: { direction?: string; url: string | null; name?: string; ws?: string }
) =>
  pg.query(
    `INSERT INTO webhook_subscriptions (user_id, name, url, event_types, secret, workspace_id${
      row.direction ? ", direction" : ""
    }) VALUES ('u-1', $1, $2, '{}', 'sec', $3${row.direction ? ", $4" : ""})`,
    [
      row.name ?? "s",
      row.url,
      row.ws ?? WS1,
      ...(row.direction ? [row.direction] : []),
    ]
  );

async function migrated(base: string): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(REFERENCED + base);
  await pg.exec(`INSERT INTO workspaces (id) VALUES ('${WS1}'), ('${WS2}')`);
  return pg;
}

describe(
  "migration 0362 — webhook_subscriptions.direction",
  { timeout: 60_000 },
  () => {
    it("non-vacuity: the schema and the coherence list declare it, the pre-0362 table lacks it", async () => {
      expect(
        getTableConfig(webhookSubscriptions).columns.map((c) => c.name)
      ).toContain("direction");
      expect(
        REQUIRED_COLUMNS.some(
          (c) => c.table === "webhook_subscriptions" && c.column === "direction"
        )
      ).toBe(true);
      const pg = await migrated(PRE_0362);
      const r = await pg.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_subscriptions'`
      );
      expect(r.rows.map((x) => x.column_name)).not.toContain("direction");
    });

    it("a booted pod: existing rows read outbound and keep their url; idempotent", async () => {
      const pg = await migrated(PRE_0362);
      await insert(pg, { url: "https://hook.example/x" });
      await pg.exec(M0362);
      await pg.exec(M0362);
      const r = await pg.query<{ direction: string; url: string }>(
        `SELECT direction, url FROM webhook_subscriptions`
      );
      expect(r.rows).toEqual([
        { direction: "outbound", url: "https://hook.example/x" },
      ]);
    });

    for (const [label, base] of [
      ["a booted pod (pre-0362 + 0362)", PRE_0362],
      ["a fresh install (baseline + 0362)", BASELINE_HOOKS],
    ] as const) {
      it(`${label}: inbound has no url, outbound needs one, one inbound name per space`, async () => {
        const pg = await migrated(base);
        await pg.exec(M0362);
        // An inbound source has no url; an outbound row must have one.
        await insert(pg, { direction: "inbound", url: null, name: "GitHub" });
        await expect(
          insert(pg, { direction: "outbound", url: null })
        ).rejects.toThrow(/webhook_subscriptions_direction_check/);
        await expect(
          insert(pg, { direction: "sideways", url: "https://x.example" })
        ).rejects.toThrow(/webhook_subscriptions_direction_check/);
        // One inbound source per (space, name), case-insensitive…
        await expect(
          insert(pg, { direction: "inbound", url: null, name: "github" })
        ).rejects.toThrow(/webhook_subscriptions_inbound_name_uq/);
        // …but the same name in another space, or on an outbound row, is fine.
        await insert(pg, {
          direction: "inbound",
          url: null,
          name: "GitHub",
          ws: WS2,
        });
        await insert(pg, {
          direction: "outbound",
          url: "https://hook.example/x",
          name: "GitHub",
        });
      });
    }
  }
);
