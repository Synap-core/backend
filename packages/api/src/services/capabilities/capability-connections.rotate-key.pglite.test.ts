/**
 * Rotating an installed capability's key from a handed-over secret leaves
 * EXACTLY ONE secret, and the value behind the tool's `vault://<id>` is the new
 * key. On real Postgres (PGlite).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * unipile-linkedin, 2026-10-27: re-entering the key wrote a second, unlinked
 * secret and reported success; the tool kept `vault://<old>` and every run kept
 * the old (dead) key. An agent had no door at all: a provide-secret answer gives
 * it a `vault://<id>` it cannot read, and nothing turned that into the key the
 * capability's tools use.
 *
 * ── WHY PGLITE ──────────────────────────────────────────────────────────────
 * The claims are "one secret row" and "the tool's ref resolves to the new
 * value". Both are read back from real tables, decrypted with the real vault
 * key, exactly as a run would read them.
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

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: await h.init() };
});
// Not on this path (no Nango, the owner acts): kept out of the module graph.
vi.mock("../../connectors/index.js", () => ({ resolveBroker: vi.fn() }));
vi.mock("./capability-nango-sync.js", () => ({
  syncNangoConnectionsToRegistry: vi.fn(),
  detachNangoConnectionRegistry: vi.fn(),
}));
vi.mock("../../utils/workspace-role.js", () => ({
  requirePodAdmin: vi.fn(async () => {
    throw new Error("only pod administrators");
  }),
  isPodAdmin: vi.fn(async () => false),
}));

import { SQL, eq, isNull } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { decryptServerSide, encryptServerSide } from "@synap/database";
import { rotateCapabilityKeyFromSecret } from "./capability-connections.js";

/** CREATE TABLE from the drizzle definition — columns, types, literal defaults. */
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

let db: any;

const OWNER = randomUUID();
const AGENT = randomUUID();

let CAP: string;
let TOOL: string;
let OLD: string;
let NEW: string;

async function seedSecret(p: {
  value: string;
  name: string;
  capabilityId?: string | null;
  isDefault?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const blob = encryptServerSide(p.value, {
    column: "secrets.encrypted_data",
    rowId: id,
  });
  await db.insert(schema.secrets).values({
    id,
    userId: OWNER,
    name: p.name,
    type: "api_key",
    encryptedData: blob.encryptedData,
    iv: blob.iv,
    authTag: blob.authTag,
    encryptionMode: "server",
    capabilityId: p.capabilityId ?? null,
    isDefault: p.isDefault ?? false,
    isPodWide: false,
  });
  return id;
}

/** What a run reads: the value behind the tool's `vault://<id>`. */
async function valueTheToolUses(): Promise<string | null> {
  const [tool] = await db
    .select()
    .from(schema.tools)
    .where(eq(schema.tools.id, TOOL));
  const id = String(tool.credentialRef).replace(/^vault:\/\//, "");
  const [row] = await db
    .select()
    .from(schema.secrets)
    .where(eq(schema.secrets.id, id));
  if (!row || row.deletedAt) return null;
  return decryptServerSide(
    { encryptedData: row.encryptedData, iv: row.iv, authTag: row.authTag },
    { column: "secrets.encrypted_data", rowId: row.id }
  );
}

async function liveSecrets(): Promise<string[]> {
  const rows = await db
    .select({ id: schema.secrets.id })
    .from(schema.secrets)
    .where(isNull(schema.secrets.deletedAt));
  return rows.map((r: { id: string }) => r.id);
}

async function handOverTo(agentId: string, secretId: string): Promise<void> {
  await db.insert(schema.vaultGrants).values({
    grantableType: "secret",
    grantableId: secretId,
    grantedTo: agentId,
    scope: "session",
    createdBy: OWNER,
  });
}

beforeAll(async () => {
  db = await h.init();
  for (const t of [
    schema.secrets,
    schema.secretAuditLog,
    schema.secretUsages,
    schema.tools,
    schema.links,
    schema.vaultGrants,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

afterAll(async () => {
  await h.client?.close();
});

beforeEach(async () => {
  for (const t of [
    "secrets",
    "secret_audit_log",
    "tools",
    "links",
    "vault_grants",
  ]) {
    await h.client!.exec(`delete from "${t}";`);
  }
  // Installed: the applier stored the key, stamped it as the capability's
  // default credential, and wrote it into the tool's credentialRef.
  CAP = randomUUID();
  TOOL = randomUUID();
  OLD = await seedSecret({
    value: "old-key",
    name: "Acme API key",
    capabilityId: CAP,
    isDefault: true,
  });
  await db.insert(schema.tools).values({
    id: TOOL,
    name: "acme",
    kind: "api",
    createdBy: OWNER,
    credentialRef: `vault://${OLD}`,
  });
  await db.insert(schema.links).values({
    fromType: "tool",
    fromId: TOOL,
    toType: "capability",
    toId: CAP,
    linkType: "member_of",
  });
  // The person answered a provide-secret ask: a new secret in their vault.
  NEW = await seedSecret({ value: "new-key", name: "New Acme key" });
});

describe("rotateCapabilityKeyFromSecret", () => {
  it("the agent the key was handed to rotates it: one secret, the tool's ref unchanged, its value the new key", async () => {
    await handOverTo(AGENT, NEW);
    expect(await valueTheToolUses()).toBe("old-key");

    const out = await rotateCapabilityKeyFromSecret({
      capabilityId: CAP,
      actorUserId: OWNER,
      sourceSecretId: NEW,
      agentUserId: AGENT,
    });

    expect(out.status).toBe("rotated");
    expect(await liveSecrets()).toEqual([OLD]);
    expect(await valueTheToolUses()).toBe("new-key");
  });

  it("an agent naming a secret nobody handed it is refused and nothing changes", async () => {
    await handOverTo(randomUUID(), NEW);

    await expect(
      rotateCapabilityKeyFromSecret({
        capabilityId: CAP,
        actorUserId: OWNER,
        sourceSecretId: NEW,
        agentUserId: AGENT,
      })
    ).rejects.toThrow(/not handed to you/);

    expect((await liveSecrets()).sort()).toEqual([OLD, NEW].sort());
    expect(await valueTheToolUses()).toBe("old-key");
  });

  it("another capability's key is never consumed", async () => {
    const otherCapKey = await seedSecret({
      value: "other-cap-key",
      name: "Other key",
      capabilityId: randomUUID(),
    });

    await expect(
      rotateCapabilityKeyFromSecret({
        capabilityId: CAP,
        actorUserId: OWNER,
        sourceSecretId: otherCapKey,
      })
    ).rejects.toThrow(/already the key/);

    expect((await liveSecrets()).sort()).toEqual(
      [OLD, NEW, otherCapKey].sort()
    );
    expect(await valueTheToolUses()).toBe("old-key");
  });

  it("a capability whose tools use no vault key has nothing to rotate", async () => {
    await expect(
      rotateCapabilityKeyFromSecret({
        capabilityId: randomUUID(),
        actorUserId: OWNER,
        sourceSecretId: NEW,
      })
    ).rejects.toThrow(/no key to replace/);
    expect((await liveSecrets()).sort()).toEqual([OLD, NEW].sort());
  });
});
