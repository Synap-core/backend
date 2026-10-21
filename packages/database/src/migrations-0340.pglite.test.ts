/**
 * REAL-POSTGRES (PGlite) test for migration 0340 — signed-in devices of the
 * Synap apps (join plan target A).
 *
 * PRE-0340 SHAPE: what a pod that ran 0339 has — the baseline's own oauth and
 * apps blocks, 0338, 0338b and 0339 on them. `users` is a one-column stand-in.
 *
 * Pinned:
 *   - 0340 runs TWICE without error, keeps a pod app's refresh token, and ends
 *     with exactly the Drizzle columns of the three tables it touches;
 *   - a refresh token has EXACTLY one owner (an app OR a device): neither and
 *     both are refused (23514), a device's token needs no app;
 *   - ending a device's life cascades: deleting the device deletes its access
 *     and refresh tokens; deleting the person deletes their devices;
 *   - an access token hash is unique;
 *   - a fresh install (the baseline's 0339 + 0340 blocks) ends in the same
 *     shape, and 0339 + 0340 then run as no-ops;
 *   - the boot coherence list names the new columns, attributed to 0340.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  oauthAuthorizationCodes,
  oauthRefreshTokens,
  personDeviceTokens,
  personDevices,
} from "./schema/pod-oauth.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, `../migrations/${f}`), "utf8");
const M0340_FILE = "0340_person_devices.sql";
const M0340 = read(M0340_FILE);
const M0339 = read("0339_oauth_refresh_tokens.sql");
const M0338 = read("0338_pod_app_oauth.sql");
const M0338B = read("0338b_pod_app_oauth_apps.sql");
const BASELINE = read("0000_baseline_schema.sql");

const slice = (from: string, to: string) =>
  BASELINE.slice(BASELINE.indexOf(from), BASELINE.indexOf(to));
const BASELINE_OAUTH = slice(
  "-- oauth_clients / oauth_authorization_codes",
  "-- ─── 3. events"
);
const BASELINE_APPS = slice("-- apps (0309)", "-- 0319: lifecycle columns");
/** The baseline's 0339 and 0340 blocks: from 0339's comment to the end. */
const BASELINE_TAIL = BASELINE.slice(
  BASELINE.indexOf("-- 0339: a pod app's rotating")
);
const USERS_STUB = `CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY);`;

const OWNER = "u-owner";
const CIMD_ID = "https://studio.example.com/.well-known/synap-client.json";

async function base(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(USERS_STUB);
  await pg.exec(BASELINE_OAUTH);
  await pg.exec(M0338);
  await pg.exec(BASELINE_APPS);
  await pg.exec(M0338B);
  await pg.query(`INSERT INTO users (id) VALUES ($1)`, [OWNER]);
  return pg;
}

async function pre0340(): Promise<PGlite> {
  const pg = await base();
  await pg.exec(M0339);
  // The baseline's oauth section is today's shape; a pod that ran only up to
  // 0339 had no `auth_time` / `step_up` on its codes.
  await pg.exec(
    `ALTER TABLE "oauth_authorization_codes" DROP COLUMN IF EXISTS "auth_time";
     ALTER TABLE "oauth_authorization_codes" DROP COLUMN IF EXISTS "step_up"`
  );
  return pg;
}

async function columnsOf(pg: PGlite, table: string): Promise<string[]> {
  const r = await pg.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [table]
  );
  return r.rows.map((x) => x.column_name).sort();
}

const declared = (table: PgTable) =>
  getTableConfig(table)
    .columns.map((c) => c.name)
    .sort();

async function sqlState(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

async function expectFinalShape(pg: PGlite) {
  expect(await columnsOf(pg, "oauth_refresh_tokens")).toEqual(
    declared(oauthRefreshTokens)
  );
  expect(await columnsOf(pg, "person_devices")).toEqual(
    declared(personDevices)
  );
  expect(await columnsOf(pg, "person_device_tokens")).toEqual(
    declared(personDeviceTokens)
  );
  expect(await columnsOf(pg, "oauth_authorization_codes")).toEqual(
    declared(oauthAuthorizationCodes)
  );
}

const insertApp = async (pg: PGlite) =>
  (
    await pg.query<{ id: string }>(
      `INSERT INTO apps (owner_user_id, public_id, name, mode, oauth_client_id)
       VALUES ($1, $2, 'Studio', 'oauth', $3) RETURNING id`,
      [OWNER, `app_${randomUUID()}`, CIMD_ID]
    )
  ).rows[0]!.id;

const insertDevice = async (pg: PGlite) =>
  (
    await pg.query<{ id: string }>(
      `INSERT INTO person_devices (user_id, client_id, expires_at)
       VALUES ($1, 'synap-desktop', now() + interval '180 days') RETURNING id`,
      [OWNER]
    )
  ).rows[0]!.id;

const insertRefresh = (
  pg: PGlite,
  owner: { appId?: string | null; deviceId?: string | null }
) =>
  pg.query(
    `INSERT INTO oauth_refresh_tokens
       (token_hash, family_id, client_id, user_id, app_id, device_id, expires_at)
     VALUES ($1, $2, 'c', $3, $4, $5, now() + interval '30 days')`,
    [
      `h-${randomUUID()}`,
      randomUUID(),
      OWNER,
      owner.appId ?? null,
      owner.deviceId ?? null,
    ]
  );

const insertAccess = (pg: PGlite, deviceId: string, hash = randomUUID()) =>
  pg.query(
    `INSERT INTO person_device_tokens (token_hash, device_id, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [hash, deviceId]
  );

const count = async (pg: PGlite, table: string) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))
    .rows[0]!.n;

describe("migration 0340 — person devices", { timeout: 60_000 }, () => {
  it("non-vacuity: a pod that ran 0339 has no device tables, no device_id, no code auth_time or step_up", async () => {
    const pg = await pre0340();
    expect(await columnsOf(pg, "person_devices")).toEqual([]);
    const codes = await columnsOf(pg, "oauth_authorization_codes");
    expect(codes).not.toContain("auth_time");
    expect(codes).not.toContain("step_up");
    expect(await columnsOf(pg, "oauth_refresh_tokens")).not.toContain(
      "device_id"
    );
  });

  it("runs twice, keeps a pod app's refresh token, ends with exactly the Drizzle columns", async () => {
    const pg = await pre0340();
    const appId = await insertApp(pg);
    await pg.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, user_id, app_id, expires_at)
       VALUES ('kept', $1, 'c', $2, $3, now() + interval '30 days')`,
      [randomUUID(), OWNER, appId]
    );
    await pg.exec(M0340);
    await pg.exec(M0340);
    await expectFinalShape(pg);
    expect(await count(pg, "oauth_refresh_tokens")).toBe(1);
  });

  it("a refresh token has exactly one owner: an app or a device", async () => {
    const pg = await pre0340();
    await pg.exec(M0340);
    const appId = await insertApp(pg);
    const deviceId = await insertDevice(pg);
    expect(await sqlState(insertRefresh(pg, { appId }))).toBeNull();
    expect(await sqlState(insertRefresh(pg, { deviceId }))).toBeNull();
    expect(await sqlState(insertRefresh(pg, {}))).toBe("23514");
    expect(await sqlState(insertRefresh(pg, { appId, deviceId }))).toBe(
      "23514"
    );
    expect(
      await sqlState(
        insertRefresh(pg, { deviceId: "00000000-0000-4000-8000-000000000000" })
      )
    ).toBe("23503");
  });

  it("a device's end cascades: its tokens go with it, and it goes with its person", async () => {
    const pg = await pre0340();
    await pg.exec(M0340);
    const deviceId = await insertDevice(pg);
    await insertRefresh(pg, { deviceId });
    await insertAccess(pg, deviceId);
    await pg.query(`DELETE FROM person_devices WHERE id = $1`, [deviceId]);
    expect(await count(pg, "oauth_refresh_tokens")).toBe(0);
    expect(await count(pg, "person_device_tokens")).toBe(0);

    const second = await insertDevice(pg);
    await insertAccess(pg, second);
    await pg.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    expect(await count(pg, "person_devices")).toBe(0);
    expect(await count(pg, "person_device_tokens")).toBe(0);
  });

  it("an access token hash is unique, and names a real device", async () => {
    const pg = await pre0340();
    await pg.exec(M0340);
    const deviceId = await insertDevice(pg);
    expect(await sqlState(insertAccess(pg, deviceId, "same"))).toBeNull();
    expect(await sqlState(insertAccess(pg, deviceId, "same"))).toBe("23505");
    expect(
      await sqlState(
        insertAccess(pg, "00000000-0000-4000-8000-000000000000", "other")
      )
    ).toBe("23503");
  });

  it("a fresh install (the baseline's 0339 + 0340 blocks) ends in the same shape; the migrations are then no-ops", async () => {
    const pg = await base();
    expect(BASELINE_TAIL).toContain(
      `CREATE TABLE IF NOT EXISTS "person_devices"`
    );
    await pg.exec(BASELINE_TAIL);
    await expectFinalShape(pg);
    await pg.exec(M0339);
    await pg.exec(M0340);
    await expectFinalShape(pg);
    expect(await sqlState(insertRefresh(pg, {}))).toBe("23514");
  });

  it("the boot coherence list names the new columns, attributed to 0340", () => {
    const required = REQUIRED_COLUMNS.filter((r) => r.addedBy === M0340_FILE);
    expect(required.length).toBeGreaterThanOrEqual(3);
    const byTable: Record<string, string[]> = {
      oauth_refresh_tokens: declared(oauthRefreshTokens),
      person_devices: declared(personDevices),
      person_device_tokens: declared(personDeviceTokens),
      oauth_authorization_codes: declared(oauthAuthorizationCodes),
    };
    for (const r of required) {
      expect(Object.keys(byTable)).toContain(r.table);
      expect(byTable[r.table]).toContain(r.column);
    }
  });
});
