/**
 * `validateRealtimeApiKey` on a real Postgres (PGlite): the realtime handshake
 * pays at most one bcrypt per LEGACY key, never one per key on the pod.
 *
 * The defect this pins: the validator ignored `key_lookup_hash` and
 * bcrypt-compared (cost 12, ~0.7 s) every active key sharing the prefix. Any
 * unauthenticated `/presence` handshake with a made-up `synap_user_…` key cost
 * N bcrypts, a CPU denial of service that grows with the pod's key count. The
 * canonical verifier (`ApiKeyService.validateApiKey`) looks the sha256 up first
 * and falls back to bcrypt only for rows that have no lookup hash yet.
 *
 * bcrypt is faked (`compare` counts calls, a hash is `bcrypt(<plain>)`), so the
 * count is exactly the number of rows the query handed to bcrypt.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init() };
});

const compare = vi.hoisted(() =>
  vi.fn(async (plain: string, hash: string) => hash === `bcrypt(${plain})`)
);
vi.mock("bcrypt", () => ({ default: { compare } }));

import { getTableConfig } from "drizzle-orm/pg-core";
import { apiKeys } from "@synap/database/schema";
import { validateRealtimeApiKey } from "../api-key-auth.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  await h.init();
  const cfg = getTableConfig(apiKeys);
  const cols = (
    cfg.columns as unknown as { name: string; getSQLType(): string }[]
  ).map((c) => {
    const t = c.getSQLType().replace(/\(.*\)/, "");
    return `"${c.name}" ${/^(text|uuid|boolean|bigint|timestamp)/.test(t) ? t : "text"}`;
  });
  await h.client!.exec(`create table "${cfg.name}" (${cols.join(", ")});`);
});

beforeEach(async () => {
  await q(`delete from api_keys`);
  compare.mockClear();
});

async function insertKey(
  plain: string,
  opts: { lookup?: boolean; active?: boolean; expiresAt?: Date } = {}
) {
  await q(
    `insert into api_keys (id, user_id, key_name, key_prefix, key_hash, key_lookup_hash,
       key_type, scope, is_active, expires_at, usage_count)
     values ($1, $2, $3, 'synap_user_', $4, $5, 'user_pat', $6, $7, $8, 0)`,
    [
      randomUUID(),
      `user-${plain}`,
      `key ${plain}`,
      `bcrypt(${plain})`,
      opts.lookup === false ? null : sha(plain),
      ["realtime:observe"],
      opts.active ?? true,
      opts.expiresAt ?? null,
    ]
  );
}

describe("validateRealtimeApiKey — sha256 first, bcrypt only for legacy rows", () => {
  it("a made-up key costs NO bcrypt when every key carries a lookup hash", async () => {
    for (let i = 0; i < 6; i++) await insertKey(`synap_user_k${i}`);
    expect(await validateRealtimeApiKey("synap_user_made_up")).toBeNull();
    expect(compare).toHaveBeenCalledTimes(0);
  });

  it("a made-up key costs ONE bcrypt per legacy key, however many keys the pod has", async () => {
    for (let i = 0; i < 6; i++) await insertKey(`synap_user_k${i}`);
    await insertKey("synap_user_legacy", { lookup: false });
    expect(await validateRealtimeApiKey("synap_user_made_up")).toBeNull();
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it("a real key is found by its lookup hash, with no bcrypt", async () => {
    for (let i = 0; i < 6; i++) await insertKey(`synap_user_k${i}`);
    const r = await validateRealtimeApiKey("synap_user_k3");
    expect(r).toMatchObject({ userId: "user-synap_user_k3" });
    expect(compare).toHaveBeenCalledTimes(0);
  });

  it("a legacy key (no lookup hash) still validates through bcrypt", async () => {
    await insertKey("synap_user_k0");
    await insertKey("synap_user_legacy", { lookup: false });
    const r = await validateRealtimeApiKey("synap_user_legacy");
    expect(r).toMatchObject({ userId: "user-synap_user_legacy" });
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it("a revoked or expired key found by its lookup hash is refused, and not retried through bcrypt", async () => {
    await insertKey("synap_user_revoked", { active: false });
    await insertKey("synap_user_expired", {
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await validateRealtimeApiKey("synap_user_revoked")).toBeNull();
    expect(await validateRealtimeApiKey("synap_user_expired")).toBeNull();
    expect(compare).toHaveBeenCalledTimes(0);
  });
});
