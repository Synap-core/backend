/**
 * An inline secret written by the admin source-config door resolves back to the
 * value the issuer sent, through the REAL vault resolver and the REAL relay
 * credential reader, on a real Postgres (PGlite).
 *
 * The resolver reads `secrets` through its own `../client-pg.js`, not the
 * `@synap/database` barrel, so both client-pg module paths are pinned to the
 * same PGlite instance. Nothing between the write and the read is hand-built.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

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

import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  CP_RELAY_SOURCE_NAME,
  readCpRelayCredential,
  resolveVaultReferences,
} from "@synap/database";
import { writeInlineSourceConfigSecrets } from "./admin-source-configs.js";

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

type Db = Parameters<typeof writeInlineSourceConfigSecrets>[0] & {
  insert: (typeof import("@synap/database"))["db"]["insert"];
  query: (typeof import("@synap/database"))["db"]["query"];
};

/** An unsigned JWT-shaped string — raw, non-JSON plaintext like the CP relay key. */
function relayJwt(): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 30 * 86_400;
  return `${enc({ alg: "ES256" })}.${enc({ type: "pod_relay", podId: "pod-1", exp })}.${randomBytes(16).toString("base64url")}`;
}

let db: Db;

beforeAll(async () => {
  db = (await h.init()) as Db;
  for (const table of [schema.secrets, schema.sourceConfigs]) {
    await h.client!.exec(ddlFor(table as unknown as PgTable));
  }
}, 120_000);

afterAll(async () => {
  await h.client?.close();
});

describe("admin source-config inline secrets resolve through the vault", () => {
  it("a raw relay key round-trips through resolveVaultReferences", async () => {
    const userId = randomUUID();
    const relayKey = relayJwt();

    const { configOut, createdSecretIds } =
      await writeInlineSourceConfigSecrets(db, {
        userId,
        sourceName: CP_RELAY_SOURCE_NAME,
        config: { note: "kept" },
        secrets: [{ field: "relayKey", value: relayKey }],
      });

    expect(createdSecretIds).toHaveLength(1);
    expect(configOut.note).toBe("kept");
    const resolved = await resolveVaultReferences(
      { relayKey: configOut.relayKey as string },
      userId
    );
    expect(resolved.relayKey).toBe(relayKey);
  });

  it("the relay credential reader returns the key from a door-written row", async () => {
    const userId = randomUUID();
    const relayKey = relayJwt();

    const { configOut } = await writeInlineSourceConfigSecrets(db, {
      userId,
      sourceName: CP_RELAY_SOURCE_NAME,
      config: {},
      secrets: [{ field: "relayKey", value: relayKey }],
    });
    await db.insert(schema.sourceConfigs).values({
      userId,
      providerType: "cp-relay",
      name: CP_RELAY_SOURCE_NAME,
      config: configOut,
      enabled: true,
    });

    delete process.env.CP_RELAY_KEY;
    delete process.env.SOURCE_RELAY_KEY;
    const credential = await readCpRelayCredential({
      database: db,
      resolveVault: resolveVaultReferences,
    });
    expect(credential?.key).toBe(relayKey);
  });
});
