/**
 * REAL-POSTGRES (PGlite) test for migration 0399 — installations. The
 * migration and the baseline create `installations`, `installation_bindings`,
 * `host_jobs` and `intent_defaults` with EVERY column, index and unique the
 * drizzle schema declares; re-running is a no-op; each CHECK stores only the
 * declared states (`stalled` is a READ verdict, never stored); `public` can
 * never be a remembered provider choice; a deleted provider takes its
 * remembered default with it while an installation keeps its history; and
 * schema-coherence names every table.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  installations,
  INSTALLATION_STATUSES,
} from "./schema/installations.js";
import {
  installationBindings,
  INSTALLATION_BINDING_STATES,
} from "./schema/installation-bindings.js";
import {
  hostJobs,
  HOST_JOB_KINDS,
  HOST_JOB_STATUSES,
} from "./schema/host-jobs.js";
import { intentDefaults } from "./schema/intent-defaults.js";
import { REQUIRED_COLUMNS } from "./utils/schema-coherence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0399 = readFileSync(
  resolve(HERE, "../migrations/0399_installations.sql"),
  "utf8"
);
const BASELINE = readFileSync(
  resolve(HERE, "../migrations/0000_baseline_schema.sql"),
  "utf8"
);

const STUBS = `
  CREATE TABLE capabilities (id uuid PRIMARY KEY);
  CREATE TABLE api_keys (id uuid PRIMARY KEY);
  CREATE TABLE skills (id uuid PRIMARY KEY);
`;

const TABLES: Array<{ table: PgTable; columns: number }> = [
  { table: installations, columns: 21 },
  { table: installationBindings, columns: 21 },
  { table: hostJobs, columns: 29 },
  { table: intentDefaults, columns: 9 },
];

async function fresh(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(STUBS);
  await pg.exec(M0399);
  return pg;
}

async function newInstallation(pg: PGlite, capabilityId?: string) {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO installations (user_id, capability_id, capability_key, machine_user_id)
     VALUES ('u', $1, 'hyperframes', 'm') RETURNING id`,
    [capabilityId ?? null]
  );
  return r.rows[0]!.id;
}

describe("migration 0399 — installations", () => {
  it("creates every declared column, index and unique, idempotently", async () => {
    const pg = new PGlite();
    await pg.exec(STUBS);
    await pg.exec(M0399);
    await pg.exec(M0399);
    for (const { table, columns } of TABLES) {
      const cfg = getTableConfig(table);
      const declared = cfg.columns.map((c) => c.name);
      expect(declared.length, cfg.name).toBe(columns);
      const cols = await pg.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [cfg.name]
      );
      expect(cols.rows.map((r) => r.column_name).sort(), cfg.name).toEqual(
        [...declared].sort()
      );
      const idx = await pg.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
        [cfg.name]
      );
      const names = [
        ...cfg.indexes.map((i) => i.config.name!),
        ...cfg.uniqueConstraints.map((u) => u.name!),
      ];
      expect(idx.rows.map((r) => r.indexname)).toEqual(
        expect.arrayContaining(names)
      );
    }
    await pg.close();
  }, 60_000);

  it("stores only the declared states and kinds; stalled is never stored", async () => {
    const pg = await fresh();
    for (const status of INSTALLATION_STATUSES) {
      await pg.query(
        `INSERT INTO installations (user_id, capability_key, machine_user_id, status)
         VALUES ('u', 'k', 'm', $1)`,
        [status]
      );
    }
    await expect(
      pg.query(
        `INSERT INTO installations (user_id, capability_key, machine_user_id, status)
         VALUES ('u', 'k', 'm', 'stalled')`
      )
    ).rejects.toThrow(/installations_status_check/);

    const inst = await newInstallation(pg);
    for (const state of INSTALLATION_BINDING_STATES) {
      await pg.query(
        `INSERT INTO installation_bindings (installation_id, user_id, need_key, intent, state)
         VALUES ($1, 'u', 'studio_url', 'expose_http', $2)`,
        [inst, state]
      );
    }
    await expect(
      pg.query(
        `INSERT INTO installation_bindings (installation_id, user_id, need_key, intent, state)
         VALUES ($1, 'u', 'studio_url', 'expose_http', 'stalled')`,
        [inst]
      )
    ).rejects.toThrow(/installation_bindings_state_check/);

    for (const kind of HOST_JOB_KINDS) {
      for (const status of HOST_JOB_STATUSES) {
        await pg.query(
          `INSERT INTO host_jobs (kind, installation_id, user_id, machine_user_id, spec, status)
           VALUES ($1, $2, 'u', 'm', '{}'::jsonb, $3)`,
          [kind, inst, status]
        );
      }
    }
    await expect(
      pg.query(
        `INSERT INTO host_jobs (kind, installation_id, user_id, machine_user_id, spec, status)
         VALUES ('install', $1, 'u', 'm', '{}'::jsonb, 'stalled')`,
        [inst]
      )
    ).rejects.toThrow(/host_jobs_status_check/);
    await expect(
      pg.query(
        `INSERT INTO host_jobs (kind, installation_id, user_id, machine_user_id, spec)
         VALUES ('shell', $1, 'u', 'm', '{}'::jsonb)`,
        [inst]
      )
    ).rejects.toThrow(/host_jobs_kind_check/);
    await pg.close();
  }, 60_000);

  it("never remembers public as a provider default", async () => {
    const pg = await fresh();
    const cap = randomUUID();
    await pg.query(`INSERT INTO capabilities VALUES ($1)`, [cap]);
    const insert = (hash: string, constraints: unknown) =>
      pg.query(
        `INSERT INTO intent_defaults (user_id, intent, constraints_hash, constraints, provider_capability_id)
         VALUES ('u', 'expose_http', $1, $2::jsonb, $3)`,
        [hash, JSON.stringify(constraints), cap]
      );
    // Accepted: no auth, or auth modes that are not public.
    await insert("a", {});
    await insert("b", { auth: "tailnet" });
    await insert("c", { auth: { anyOf: ["pod", "tailnet", "provider"] } });
    await insert("d", { auth: ["tailnet"] });
    // Refused: public asked, listed, or allowed.
    for (const [hash, constraints] of [
      ["e", { auth: "public" }],
      ["f", { auth: ["tailnet", "public"] }],
      ["g", { auth: { anyOf: ["pod", "public"] } }],
    ] as const) {
      await expect(insert(hash, constraints)).rejects.toThrow(
        /intent_defaults_never_public_check/
      );
    }
    const n = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM intent_defaults`
    );
    expect(n.rows[0]!.n).toBe(4);
    await pg.close();
  }, 60_000);

  it("one remembered choice per person, space (NULL = all), intent and constraints", async () => {
    const pg = await fresh();
    const cap = randomUUID();
    await pg.query(`INSERT INTO capabilities VALUES ($1)`, [cap]);
    const insert = (ws: string | null) =>
      pg.query(
        `INSERT INTO intent_defaults (user_id, workspace_id, intent, constraints_hash, provider_capability_id)
         VALUES ('u', $1, 'expose_http', 'h', $2)`,
        [ws, cap]
      );
    await insert(null);
    await expect(insert(null)).rejects.toThrow(/intent_defaults_scope_unique/);
    await insert(randomUUID());
    await pg.close();
  }, 60_000);

  it("a deleted provider takes its default; an installation keeps its history", async () => {
    const pg = await fresh();
    const cap = randomUUID();
    await pg.query(`INSERT INTO capabilities VALUES ($1)`, [cap]);
    const inst = await newInstallation(pg, cap);
    await pg.query(
      `INSERT INTO installation_bindings (installation_id, user_id, need_key, intent, provider_capability_id)
       VALUES ($1, 'u', 'studio_url', 'expose_http', $2)`,
      [inst, cap]
    );
    await pg.query(
      `INSERT INTO intent_defaults (user_id, intent, provider_capability_id)
       VALUES ('u', 'expose_http', $1)`,
      [cap]
    );
    await pg.query(`DELETE FROM capabilities WHERE id = $1`, [cap]);
    const i = await pg.query<{ capability_id: string | null; key: string }>(
      `SELECT capability_id, capability_key AS key FROM installations`
    );
    expect(i.rows).toEqual([{ capability_id: null, key: "hyperframes" }]);
    const b = await pg.query<{ p: string | null }>(
      `SELECT provider_capability_id AS p FROM installation_bindings`
    );
    expect(b.rows).toEqual([{ p: null }]);
    const d = await pg.query(`SELECT 1 FROM intent_defaults`);
    expect(d.rows).toHaveLength(0);
    await pg.close();
  }, 60_000);

  it("the baseline carries the same tables, and schema-coherence names each", () => {
    for (const { table } of TABLES) {
      const name = getTableConfig(table).name;
      const head = `CREATE TABLE IF NOT EXISTS "${name}" (`;
      const start = M0399.indexOf(head);
      expect(start, name).toBeGreaterThanOrEqual(0);
      const create = M0399.slice(start, M0399.indexOf(");", start) + 2);
      expect(create.length, name).toBeGreaterThan(200);
      expect(BASELINE, name).toContain(create.trim());
      for (const i of getTableConfig(table).indexes) {
        expect(BASELINE).toContain(`"${i.config.name}"`);
      }
      expect(
        REQUIRED_COLUMNS.filter((c) => c.table === name).length,
        name
      ).toBeGreaterThan(0);
    }
    for (const check of [
      "installations_status_check",
      "installation_bindings_state_check",
      "host_jobs_kind_check",
      "host_jobs_status_check",
      "intent_defaults_never_public_check",
    ]) {
      expect(M0399).toContain(`"${check}"`);
      expect(BASELINE).toContain(`"${check}"`);
    }
  });
});
