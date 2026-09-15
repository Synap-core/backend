/**
 * Migration 0265 repairs `vault://<uuid>/value` references in rows written by
 * the admin source-config door, on a real Postgres (PGlite).
 *
 * Secrets are written by the real `writeInlineSourceConfigSecrets` and re-tagged
 * by the real `retagInlineSourceConfigSecrets`, so every repaired secret carries
 * the service id a committed door write leaves (`source:<config id>`). The only
 * hand-built step is the `/value` suffix the earlier writer appended. Resolution
 * is read back through the real `resolveVaultReferences`.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  process.env.VAULT_SERVER_KEY = "ab".repeat(32);
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      close: () => Promise<void>;
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
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init() };
});

import { SQL, eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  CP_RELAY_SOURCE_NAME,
  encryptServerSide,
  resolveVaultReferences,
} from "@synap/database";
import {
  retagInlineSourceConfigSecrets,
  writeInlineSourceConfigSecrets,
} from "./admin-source-configs.js";

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      "../../../database/migrations/0265_source_config_bare_vault_refs_retagged.sql",
      import.meta.url
    )
  ),
  "utf8"
);

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

type Db = Parameters<typeof writeInlineSourceConfigSecrets>[0] &
  Parameters<typeof retagInlineSourceConfigSecrets>[0] & {
    insert: (typeof import("@synap/database"))["db"]["insert"];
    query: (typeof import("@synap/database"))["db"]["query"];
  };

let db: Db;

/** The reference form the earlier writer stored. */
const suffixed = (ref: unknown) => `${ref as string}/value`;

async function insertConfig(
  userId: string,
  config: Record<string, unknown>
): Promise<string> {
  const [row] = await db
    .insert(schema.sourceConfigs)
    .values({
      userId,
      providerType: "cp-relay",
      name: CP_RELAY_SOURCE_NAME,
      config,
      enabled: true,
    })
    .returning();
  return row!.id;
}

async function configOf(id: string): Promise<Record<string, unknown>> {
  const row = await db.query.sourceConfigs.findFirst({
    where: eq(schema.sourceConfigs.id, id),
  });
  return row!.config as Record<string, unknown>;
}

/** A committed door write whose config holds the suffixed reference. */
async function doorWrite(
  userId: string,
  opts: { retag: boolean; nested?: boolean }
) {
  const value = `raw-${randomUUID()}`;
  const { configOut, createdSecretIds } = await writeInlineSourceConfigSecrets(
    db,
    {
      userId,
      sourceName: CP_RELAY_SOURCE_NAME,
      config: {},
      secrets: [{ field: "relayKey", value }],
    }
  );
  const ref = suffixed(configOut.relayKey);
  const configId = await insertConfig(
    userId,
    opts.nested
      ? { relayUrl: "https://cp", headers: { Authorization: ref } }
      : { relayUrl: "https://cp", relayKey: ref }
  );
  if (opts.retag) {
    await retagInlineSourceConfigSecrets(db, configId, createdSecretIds);
  }
  return { value, configId, secretId: createdSecretIds[0]! };
}

const owner = randomUUID();
const stranger = randomUUID();
let committed: Awaited<ReturnType<typeof doorWrite>>;
let nested: Awaited<ReturnType<typeof doorWrite>>;
let preRetag: Awaited<ReturnType<typeof doorWrite>>;
let foreignConfigId: string;
let foreignSecretId: string;
let jsonConfigId: string;
let jsonSecretId: string;
let committedBeforeRepair: string;

beforeAll(async () => {
  db = (await h.init()) as Db;
  for (const table of [schema.secrets, schema.sourceConfigs]) {
    await h.client!.exec(ddlFor(table as unknown as PgTable));
  }

  committed = await doorWrite(owner, { retag: true });
  nested = await doorWrite(owner, { retag: true, nested: true });
  preRetag = await doorWrite(owner, { retag: false });

  // Another user's committed door secret, referenced from the owner's config.
  const theirs = await doorWrite(stranger, { retag: true });
  foreignSecretId = theirs.secretId;
  foreignConfigId = await insertConfig(owner, {
    relayKey: `vault://${foreignSecretId}/value`,
  });

  // A JSON secret created outside the door, legitimately read by field.
  const blob = encryptServerSide(JSON.stringify({ value: "json-field" }));
  const [jsonSecret] = await db
    .insert(schema.secrets)
    .values({
      userId: owner,
      serviceId: "nango-connector",
      name: "json secret",
      type: "api_key",
      encryptedData: blob.encryptedData,
      iv: blob.iv,
      authTag: blob.authTag,
      encryptionMode: "server",
      encryptionVersion: 1,
    })
    .returning();
  jsonSecretId = jsonSecret!.id;
  jsonConfigId = await insertConfig(owner, {
    apiKey: `vault://${jsonSecretId}/value`,
  });

  committedBeforeRepair = (
    await resolveVaultReferences(
      { relayKey: (await configOf(committed.configId)).relayKey as string },
      owner
    )
  ).relayKey!;

  // Applied twice: the second pass must find nothing left to do.
  await h.client!.exec(MIGRATION);
  await h.client!.exec(MIGRATION);
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

describe("migration 0265: bare vault refs for re-tagged source-config secrets", () => {
  it("a committed door secret is tagged source:<config id> and unreadable before the repair", async () => {
    const secret = await db.query.secrets.findFirst({
      where: eq(schema.secrets.id, committed.secretId),
    });
    expect(secret!.serviceId).toBe(`source:${committed.configId}`);
    expect(committedBeforeRepair).toBe("");
  });

  it("rewrites the committed shape to a bare ref that resolves to the raw secret", async () => {
    const cfg = await configOf(committed.configId);
    expect(cfg).toEqual({
      relayUrl: "https://cp",
      relayKey: `vault://${committed.secretId}`,
    });
    const resolved = await resolveVaultReferences(
      { relayKey: cfg.relayKey as string },
      owner
    );
    expect(resolved.relayKey).toBe(committed.value);
  });

  it("rewrites a committed reference at any depth", async () => {
    expect(await configOf(nested.configId)).toEqual({
      relayUrl: "https://cp",
      headers: { Authorization: `vault://${nested.secretId}` },
    });
  });

  it("rewrites a secret left tagged source:admin-provisioned", async () => {
    const cfg = await configOf(preRetag.configId);
    expect(cfg.relayKey).toBe(`vault://${preRetag.secretId}`);
    const resolved = await resolveVaultReferences(
      { relayKey: cfg.relayKey as string },
      owner
    );
    expect(resolved.relayKey).toBe(preRetag.value);
  });

  it("leaves another user's secret and a JSON secret from elsewhere untouched", async () => {
    expect(await configOf(foreignConfigId)).toEqual({
      relayKey: `vault://${foreignSecretId}/value`,
    });
    const jsonCfg = await configOf(jsonConfigId);
    expect(jsonCfg).toEqual({ apiKey: `vault://${jsonSecretId}/value` });
    const resolved = await resolveVaultReferences(
      { apiKey: jsonCfg.apiKey as string },
      owner
    );
    expect(resolved.apiKey).toBe("json-field");
  });
});
