/**
 * An UNKNOWN key must not buy a bcrypt compare per stored key.
 *
 * Measured live (perso pod, 2026-10-12): a made-up `synap_hub_live_…` secret
 * missed the sha256 lookup, then bcrypt-compared (cost 12, ~0.7s each)
 * against EVERY stored key with that prefix — 123 rows, ~12s per request, and
 * a few in parallel starved libuv's 4-thread pool. `/auth/key-state` skips
 * auth, so anyone could drive it. The fallback exists for one thing: a LEGACY
 * key minted before `key_lookup_hash` (NULL there) and still usable. A row
 * that HAS a lookup hash was already ruled out by the sha256 miss; a revoked
 * row can never authenticate again.
 *
 * Driven on PGlite through the real `apiKeyService`, counting bcrypt calls.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID, createHash, randomBytes } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  compares: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("bcrypt", async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, unknown> }>();
  const real = actual.default as {
    compare: (a: string, b: string) => Promise<boolean>;
    hash: (a: string, c: number) => Promise<string>;
  };
  const wrapped = {
    ...real,
    compare: async (a: string, b: string) => {
      h.compares++;
      return real.compare(a, b);
    },
  };
  return { ...actual, default: wrapped, ...wrapped };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));

import bcrypt from "bcrypt";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { pgliteTableDdl } from "../__tests__/pglite-ddl.js";
import { apiKeyService } from "./api-keys.js";

const USER = randomUUID();
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const secret = () => `synap_hub_live_${randomBytes(24).toString("hex")}`;

/** A stored key row. Cheap bcrypt cost: the COUNT is under test, not the cost. */
async function storeKey(opts: {
  plain?: string;
  legacy: boolean;
  active: boolean;
}): Promise<string> {
  const plain = opts.plain ?? secret();
  await q(
    `insert into api_keys (id, user_id, is_active, key_type, key_name, key_prefix,
       key_hash, key_lookup_hash, scope)
     values ($1,$2,$3,'hub_inbound','k','synap_hub_live_',$4,$5,'{}')`,
    [
      randomUUID(),
      USER,
      opts.active,
      await bcrypt.hash(plain, 4),
      opts.legacy ? null : createHash("sha256").update(plain).digest("hex"),
    ]
  );
  return plain;
}

let legacyLive = "";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1,'u@x.test')`, [USER]);
  // The live pod's shape, scaled down: most rows carry a lookup hash, many
  // legacy rows are revoked, a couple of legacy keys still work.
  for (let i = 0; i < 12; i++)
    await storeKey({ legacy: false, active: i % 2 === 0 });
  for (let i = 0; i < 9; i++) await storeKey({ legacy: true, active: false });
  legacyLive = await storeKey({ legacy: true, active: true });
  await storeKey({ legacy: true, active: true });
}, 120_000);

beforeEach(() => {
  h.compares = 0;
  apiKeyService.invalidateVerificationCache();
});

describe("the bcrypt fallback only ever sees live LEGACY rows", () => {
  it("getApiKeyStatus: an unknown key compares against the 2 live legacy rows, not all 23", async () => {
    expect(await apiKeyService.getApiKeyStatus(secret())).toEqual({
      status: "not_found",
    });
    expect(h.compares).toBe(2);
  });

  it("validateApiKey: an unknown key compares against the 2 live legacy rows, not all 14 active", async () => {
    expect(await apiKeyService.validateApiKey(secret())).toBeNull();
    expect(h.compares).toBe(2);
  });

  it("positive control: a live legacy key still authenticates through bcrypt, then backfills", async () => {
    const status = await apiKeyService.getApiKeyStatus(legacyLive);
    expect(status.status).toBe("valid");
    expect(h.compares).toBeGreaterThan(0);
    // The sha256 lookup hash is written (fire-and-forget): the next request
    // takes the O(1) path with no compare at all.
    await vi.waitFor(async () => {
      const { rows } = await q<{ n: number }>(
        `select count(*)::int as n from api_keys where key_lookup_hash = $1`,
        [createHash("sha256").update(legacyLive).digest("hex")]
      );
      expect(rows[0]!.n).toBe(1);
    });
    apiKeyService.invalidateVerificationCache();
    h.compares = 0;
    expect((await apiKeyService.validateApiKey(legacyLive))?.isActive).toBe(
      true
    );
    expect(h.compares).toBe(0);
  });
});
