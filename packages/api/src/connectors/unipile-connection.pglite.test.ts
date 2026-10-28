/**
 * The messaging service's Unipile key IS the installed `unipile-linkedin`
 * capability's key: the secret its tool's `vault://<id>` names. On real
 * Postgres (PGlite), decrypted with the real vault key, as a run reads it.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * 2026-10-28: the messaging service read a SECOND setup (a DSN + key in the
 * vault `messaging-connector`, the workspace settings or UNIPILE_* env). The
 * founder's pod had the v2 capability installed and working, and the messaging
 * service still answered 409 MESSAGING_NOT_CONFIGURED.
 *
 * Also pinned: absent and broken are different answers. Not installed / no key
 * is "not set up" (the honest 409); a key that exists but cannot be read is a
 * fault, never folded into "not set up".
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
  process.env.VAULT_SERVER_KEY = "cd".repeat(32);
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
import { encryptServerSide } from "@synap/database";
import {
  resolveUnipileConnection,
  describeMessagingService,
  UNIPILE_CAPABILITY_KEY,
} from "./unipile-connection.js";

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

async function seedSecret(
  value: string,
  opts: { mode?: "server" | "client"; capabilityId?: string } = {}
): Promise<string> {
  const id = randomUUID();
  const blob = encryptServerSide(value, {
    column: "secrets.encrypted_data",
    rowId: id,
  });
  await db.insert(schema.secrets).values({
    id,
    userId: OWNER,
    name: "Unipile — Messaging & LinkedIn Unipile API key",
    type: "api_key",
    encryptedData: blob.encryptedData,
    iv: blob.iv,
    authTag: blob.authTag,
    encryptionMode: opts.mode ?? "server",
    capabilityId: opts.capabilityId ?? null,
    isDefault: true,
    isPodWide: false,
  });
  return id;
}

/** What the applier writes: the container, its tool (with the key's ref), the member edge. */
async function install(opts: {
  templateKey?: string;
  credentialRef: string | null;
  workspaceId?: string | null;
}): Promise<string> {
  const cap = randomUUID();
  const tool = randomUUID();
  await db.insert(schema.capabilities).values({
    id: cap,
    name: "Unipile — Messaging & LinkedIn",
    createdBy: OWNER,
    templateKey: opts.templateKey ?? UNIPILE_CAPABILITY_KEY,
    workspaceId: opts.workspaceId ?? null,
  });
  await db.insert(schema.tools).values({
    id: tool,
    name: "unipile_linkedin",
    kind: "api",
    createdBy: OWNER,
    credentialRef: opts.credentialRef,
    config: { baseUrl: "https://api.unipile.com/v2" },
  });
  await db.insert(schema.links).values({
    fromType: "tool",
    fromId: tool,
    toType: "capability",
    toId: cap,
    linkType: "member_of",
  });
  return cap;
}

beforeAll(async () => {
  db = await h.init();
  for (const t of [
    schema.secrets,
    schema.tools,
    schema.links,
    schema.capabilities,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

afterAll(async () => {
  await h.client?.close();
});

beforeEach(async () => {
  for (const t of ["secrets", "tools", "links", "capabilities"])
    await h.client!.exec(`delete from "${t}";`);
});

describe("the messaging service's Unipile key is the installed capability's key", () => {
  it("installed with a key → that key, decrypted (the value its tool sends)", async () => {
    const secretId = await seedSecret("live-v2-key");
    const cap = await install({ credentialRef: `vault://${secretId}` });
    expect(await resolveUnipileConnection()).toEqual({
      ok: true,
      apiKey: "live-v2-key",
      capabilityId: cap,
      secretId,
    });
    expect(await describeMessagingService()).toEqual({
      configured: true,
      capabilityKey: "unipile-linkedin",
      capabilityId: cap,
      problem: null,
      message: null,
    });
  });

  it("not installed → not set up, and the message says what to install", async () => {
    // Another capability's key is not Unipile's.
    const other = await seedSecret("apify-token");
    await install({ templateKey: "apify", credentialRef: `vault://${other}` });
    const conn = await resolveUnipileConnection();
    expect(conn).toMatchObject({ ok: false, problem: "not-installed" });
    expect(conn.ok ? "" : conn.error).toMatch(/Unipile — Messaging & LinkedIn/);
  });

  it("installed without a key → not set up (no-key)", async () => {
    const cap = await install({ credentialRef: null });
    expect(await resolveUnipileConnection()).toMatchObject({
      ok: false,
      problem: "no-key",
      capabilityId: cap,
    });
  });

  it("the key was deleted → not set up (no-key), never the deleted value", async () => {
    const secretId = await seedSecret("dead-key");
    await install({ credentialRef: `vault://${secretId}` });
    await h.client!.exec(
      `update "secrets" set deleted_at = now() where id = '${secretId}';`
    );
    expect(await resolveUnipileConnection()).toMatchObject({
      ok: false,
      problem: "no-key",
    });
  });

  it("a key the pod cannot read is a fault (unreadable), not 'not set up'", async () => {
    const secretId = await seedSecret("device-only", { mode: "client" });
    await install({ credentialRef: `vault://${secretId}` });
    expect(await resolveUnipileConnection()).toMatchObject({
      ok: false,
      problem: "unreadable",
    });
    expect(await describeMessagingService()).toMatchObject({
      configured: false,
      problem: "unreadable",
    });
  });

  it("a pod-wide install wins over a space's", async () => {
    const spaceKey = await seedSecret("space-key");
    await install({
      credentialRef: `vault://${spaceKey}`,
      workspaceId: randomUUID(),
    });
    const podKey = await seedSecret("pod-key");
    const podCap = await install({ credentialRef: `vault://${podKey}` });
    expect(await resolveUnipileConnection()).toMatchObject({
      ok: true,
      apiKey: "pod-key",
      capabilityId: podCap,
    });
  });
});
