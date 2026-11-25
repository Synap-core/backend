/**
 * A SOURCE connection (a Storybook) on a real Postgres (PGlite): a registry
 * row whose account hint names what the pod reads and which holds no secret.
 *
 *  1. `addSourceConnection` stores the EMPTY blob (never a value), reads as
 *     `source`, is idempotent per (capability, owner, hint), and is a
 *     connection the sync runner runs.
 *  2. The credential doors never let a secret and a source hint meet: adding a
 *     credential with a source hint, giving a source a key, re-pointing a
 *     source's hint, or turning a key into a source are all refused.
 *  3. The Nango reconciler never reads a source row as a broker connection it
 *     stopped reporting (it would soft-delete it).
 *
 * Tables are created FROM THEIR DRIZZLE DEFINITIONS (enums → text, constraints
 * dropped), as in connection-registry-doors.pglite.test.ts. Stubbed:
 * `encryptServerSide` (records the plaintext it was handed), the provider-key
 * resolver and `resolveBroker`.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  plaintexts: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    encryptServerSide: (plaintext: string) => {
      holder.plaintexts.push(plaintext);
      return { encryptedData: `enc(${plaintext})`, iv: "iv", authTag: "tag" };
    },
    retireConnectionRules: vi.fn(async () => ({ revokedRuleIds: [] })),
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

vi.mock("../capability-provider-resolution.js", () => ({
  resolveCapabilityNangoProviderKeys: vi.fn(async () => ["google"]),
}));

vi.mock("../../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBroker: vi.fn(async () => ({
    ok: false,
    reason: "not-configured",
    error: "none",
  })),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  secrets,
  secretAuditLog,
  secretUsages,
  entityExternalLinks,
  tools,
  links,
  users,
} from "@synap/database/schema";
import {
  addCredential,
  addSourceConnection,
  listCredentials,
  updateCredential,
} from "../capability-connections.js";
import { syncNangoConnectionsToRegistry } from "../capability-nango-sync.js";
import { resolveSyncConnections } from "../../event-sync/sync-state-store.js";

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

const TABLES = [
  secrets,
  secretAuditLog,
  secretUsages,
  entityExternalLinks,
  tools,
  links,
  users,
] as const;

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  for (const table of TABLES) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  holder.db = drizzle(client);
}, 120_000);

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  for (const table of TABLES) {
    await client.exec(
      `delete from "${getTableConfig(table as unknown as PgTable).name}";`
    );
  }
  holder.plaintexts = [];
});

const USER = "user-1";
const HINT = "storybook:Synap-core/app-bases";

async function user(id = USER): Promise<void> {
  await client.query(`insert into users (id, email) values ($1, $2)`, [
    id,
    `${id}@example.invalid`,
  ]);
}

async function row(id: string) {
  const r = await client.query<{
    account_hint: string | null;
    encrypted_data: string;
    deleted: boolean;
  }>(
    `select account_hint, encrypted_data, deleted_at is not null as deleted from secrets where id = $1`,
    [id]
  );
  return r.rows[0]!;
}

async function liveCount(): Promise<number> {
  const r = await client.query<{ n: number }>(
    `select count(*)::int as n from secrets where deleted_at is null`
  );
  return r.rows[0]!.n;
}

describe("addSourceConnection", () => {
  it("stores the empty blob, reads as a source, and is one row per (capability, owner, hint)", async () => {
    await user();
    const capabilityId = randomUUID();
    const first = await addSourceConnection({
      capabilityId,
      actorUserId: USER,
      label: "Storybook · Synap-core/app-bases",
      accountHint: HINT,
    });
    expect(first.created).toBe(true);
    expect(holder.plaintexts).toEqual([""]);
    expect(await row(first.id)).toMatchObject({
      account_hint: HINT,
      encrypted_data: "enc()",
    });

    const again = await addSourceConnection({
      capabilityId,
      actorUserId: USER,
      label: "Storybook again",
      accountHint: HINT,
    });
    expect(again).toEqual({ id: first.id, created: false });
    expect(await liveCount()).toBe(1);

    const listed = await listCredentials(capabilityId, USER);
    expect(listed.map((v) => [v.id, v.kind])).toEqual([[first.id, "source"]]);
  });

  it("is a connection the sync runner runs", async () => {
    await user();
    const capabilityId = randomUUID();
    const toolId = randomUUID();
    await client.query(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_by)
       values ($1, 'tool', $2, 'capability', $3, 'member_of', $4)`,
      [randomUUID(), toolId, capabilityId, USER]
    );
    const { id } = await addSourceConnection({
      capabilityId,
      actorUserId: USER,
      label: "Storybook",
      accountHint: HINT,
    });
    expect(await resolveSyncConnections(toolId, undefined)).toEqual([
      { id, userId: USER },
    ]);
  });

  it("refuses a hint that names no source", async () => {
    await expect(
      addSourceConnection({
        capabilityId: randomUUID(),
        actorUserId: USER,
        label: "x",
        accountHint: "conn_abcdef",
      })
    ).rejects.toThrow(/not a source account hint/);
    expect(await liveCount()).toBe(0);
  });
});

describe("a secret and a source hint never meet", () => {
  it("adding a credential with a source hint is refused, with or without a value", async () => {
    await user();
    for (const value of ["sk-real-key", undefined]) {
      await expect(
        addCredential({
          capabilityId: randomUUID(),
          actorUserId: USER,
          label: "k",
          ...(value ? { value } : {}),
          accountHint: HINT,
        })
      ).rejects.toThrow(/names a source/);
    }
    expect(await liveCount()).toBe(0);
    expect(holder.plaintexts).toEqual([]);
  });

  it("a source cannot be given a key, nor have its hint re-pointed", async () => {
    await user();
    const capabilityId = randomUUID();
    const { id } = await addSourceConnection({
      capabilityId,
      actorUserId: USER,
      label: "Storybook",
      accountHint: HINT,
    });
    await expect(
      updateCredential({
        capabilityId,
        credentialId: id,
        actorUserId: USER,
        value: "sk-real-key",
      })
    ).rejects.toThrow(/holds no secret/);
    await expect(
      updateCredential({
        capabilityId,
        credentialId: id,
        actorUserId: USER,
        accountHint: "conn_x",
      })
    ).rejects.toThrow(/cannot be changed/);
    expect(await row(id)).toMatchObject({
      account_hint: HINT,
      encrypted_data: "enc()",
    });
    expect(holder.plaintexts).toEqual([""]);
    // A rename stays allowed.
    const renamed = await updateCredential({
      capabilityId,
      credentialId: id,
      actorUserId: USER,
      label: "App bases Storybook",
    });
    expect(renamed.kind).toBe("source");
  });

  it("a key cannot become a source", async () => {
    await user();
    const capabilityId = randomUUID();
    const key = await addCredential({
      capabilityId,
      actorUserId: USER,
      label: "k",
      value: "sk-real-key",
    });
    expect(key.kind).toBe("vault");
    await expect(
      updateCredential({
        capabilityId,
        credentialId: key.id,
        actorUserId: USER,
        accountHint: HINT,
      })
    ).rejects.toThrow(/names a source/);
    expect((await row(key.id)).account_hint).toBeNull();
  });
});

describe("the Nango reconciler", () => {
  it("never retires a source row as a connection the broker stopped reporting; a Nango pointer it does", async () => {
    await user();
    const capabilityId = randomUUID();
    const { id: source } = await addSourceConnection({
      capabilityId,
      actorUserId: USER,
      label: "Storybook",
      accountHint: HINT,
    });
    const pointer = randomUUID();
    await client.query(
      `insert into secrets (id, user_id, name, type, capability_id, account_hint, is_default,
         encrypted_data, iv, auth_tag, encryption_version, encryption_mode)
       values ($1, $2, 'p', 'api_key', $3, 'conn_gone', false, '', '', '', 1, 'server')`,
      [pointer, USER, capabilityId]
    );
    // The broker answered: this user has no live connection at all.
    await syncNangoConnectionsToRegistry(capabilityId, USER, []);
    expect((await row(pointer)).deleted).toBe(true);
    expect((await row(source)).deleted).toBe(false);
  });
});
