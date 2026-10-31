/**
 * The per-key runner stamp (wave contract 3): only a request that names the
 * CLI worker (`X-Synap-Runner: synap-worker/<version>`) stamps
 * `api_keys.worker_served_at`, only on the calling key, and at most once a
 * minute. Another runner value, or no header, writes nothing. Read back out of
 * PGlite with the real `api_keys` table.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});

import { getTableConfig } from "drizzle-orm/pg-core";
import { apiKeys } from "@synap/database/schema";
import { recordWorkerServed, workerRunnerVersion } from "./worker-served.js";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const stampOf = async (id: string) =>
  (
    await q<{
      worker_served_at: Date | null;
      worker_served_version: string | null;
    }>(
      `select worker_served_at, worker_served_version from api_keys where id = $1`,
      [id]
    )
  ).rows[0];

const NOW = new Date("2026-10-31T10:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

let key: string;
const OTHER = randomUUID();

beforeAll(async () => {
  const cfg = getTableConfig(apiKeys);
  const cols = cfg.columns.map((c) => `"${c.name}" ${c.getSQLType()}`);
  await h.client!.exec(`create table api_keys (${cols.join(", ")});`);
  await q(
    `insert into api_keys (id, user_id, key_name, key_prefix, key_hash) values ($1, 'agent-b', 'b', 'synap_hub_live_', 'hash-b')`,
    [OTHER]
  );
});

beforeEach(async () => {
  // A fresh key per test: the throttle is per key and lives in the process.
  key = randomUUID();
  await q(
    `insert into api_keys (id, user_id, key_name, key_prefix, key_hash) values ($1, 'agent-a', 'a', 'synap_hub_live_', $2)`,
    [key, `hash-${key}`]
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("workerRunnerVersion — which header names the CLI worker", () => {
  it("synap-worker with or without a version; anything else is not it", () => {
    expect(workerRunnerVersion("synap-worker/0.9.1")).toBe("0.9.1");
    expect(workerRunnerVersion(" synap-worker/1.0.0-beta.2 ")).toBe(
      "1.0.0-beta.2"
    );
    expect(workerRunnerVersion("synap-worker")).toBeNull();
    // A version that is not a short plain token is dropped, the runner kept.
    expect(workerRunnerVersion("synap-worker/<script>")).toBeNull();
    expect(workerRunnerVersion(`synap-worker/${"9".repeat(65)}`)).toBeNull();

    for (const other of [
      undefined,
      null,
      "",
      "claude-code/2.1.0",
      "synap-workers/1.0.0",
      "Synap-Worker/1.0.0",
      "synap-worker/1.0.0/extra",
    ]) {
      expect(workerRunnerVersion(other)).toBeUndefined();
    }
  });
});

describe("recordWorkerServed — the stamp", () => {
  it("a synap-worker header stamps the calling key, with its version, and no other key", async () => {
    expect(await recordWorkerServed(key, "synap-worker/0.9.1", NOW)).toBe(true);
    expect(await stampOf(key)).toEqual({
      worker_served_at: NOW,
      worker_served_version: "0.9.1",
    });
    expect(await stampOf(OTHER)).toEqual({
      worker_served_at: null,
      worker_served_version: null,
    });
  });

  it("another runner value, or no header, writes nothing", async () => {
    for (const header of [
      undefined,
      "",
      "claude-code/2.1.0",
      "synap-cli/1.0",
    ]) {
      expect(await recordWorkerServed(key, header, NOW)).toBe(false);
    }
    expect(await stampOf(key)).toEqual({
      worker_served_at: null,
      worker_served_version: null,
    });
  });

  it("no key, no write", async () => {
    expect(await recordWorkerServed(undefined, "synap-worker/0.9.1", NOW)).toBe(
      false
    );
  });

  it("throttled: at most one write per key per minute", async () => {
    expect(await recordWorkerServed(key, "synap-worker/0.9.1", NOW)).toBe(true);
    expect(
      await recordWorkerServed(key, "synap-worker/0.9.2", later(30_000))
    ).toBe(false);
    expect(await stampOf(key)).toEqual({
      worker_served_at: NOW,
      worker_served_version: "0.9.1",
    });

    expect(
      await recordWorkerServed(key, "synap-worker/0.9.2", later(61_000))
    ).toBe(true);
    expect(await stampOf(key)).toEqual({
      worker_served_at: later(61_000),
      worker_served_version: "0.9.2",
    });
  });
});
