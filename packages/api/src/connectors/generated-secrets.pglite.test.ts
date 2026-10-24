/**
 * GENERATED SECRETS through the vault:// handler, on a real Postgres (PGlite)
 * with the real server-side encryption and `fetch` mocked at the network seam.
 *
 * What a reader could otherwise see, and where each is pinned:
 *  - the provider's RESPONSE (a body or an error that echoes the value) →
 *    "scrubbed from the result", "scrubbed from an error";
 *  - a LOG line → "no log line carries the value";
 *  - a tool that did not opt in, or a placeholder outside the body → sent as
 *    text, nothing minted;
 *  - a stored row someone else created → never overwritten.
 * And what must hold for it to be useful: the value that went out is the one
 * the vault keeps, one per name, rotated in place.
 *
 * The capability gate (a proposal stores only the placeholder; a proposed or
 * denied call mints nothing) is pinned in
 * `external-dispatch.generated-secrets.test.ts`.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const holder = vi.hoisted(() => {
  // A throwaway test key, generated per run (never a real one).
  process.env.VAULT_SERVER_KEY = Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
  delete process.env.SYNAP_FIELD_KEYS;
  return { db: undefined as unknown, logCalls: [] as unknown[] };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
// The provider token itself (resolved under the vault policy, not under test).
vi.mock("../utils/vault-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveVaultSecret: vi.fn(async () => "provider-token-not-under-test"),
}));
vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap-core/core")>();
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      holder.logCalls.push([level, ...args]);
    };
  const fake = () => {
    const l: Record<string, unknown> = {
      trace: record("trace"),
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      fatal: record("fatal"),
    };
    l.child = () => l;
    return l;
  };
  return { ...actual, createLogger: fake };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { decryptServerSide } from "@synap/database";
import { __vaultHandlerForTests as vaultHandler } from "./external-dispatch.js";
import {
  GENERATED_SECRET_MARKER,
  parseGeneratePlaceholder,
} from "./generated-secrets.js";

const OWNER = "owner-1";
const TOKEN_ID = "11111111-1111-4111-8111-111111111111";
const NAME = "site:shop:AUTH_SECRET";
const PLACEHOLDER = `vault://generate?name=${NAME}`;
const HEX64 = /^[0-9a-f]{64}$/;

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
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

let pg: PGlite;
type Sent = { url: string; body: unknown };
let sent: Sent[] = [];
let respond: (body: unknown) => Response;

function tool(config: Record<string, unknown>) {
  return {
    id: "tool-vercel",
    name: "vercel",
    kind: "provider",
    credentialRef: `vault://${TOKEN_ID}`,
    config: { baseUrl: "https://api.vercel.example", ...config },
  } as never;
}
const OPTED_IN = { generatedSecrets: true };

function call(
  config: Record<string, unknown>,
  body: Record<string, unknown> | undefined,
  path = "/v10/projects/shop/env"
) {
  return vaultHandler({
    input: {
      userId: OWNER,
      provider: `vault://${TOKEN_ID}`,
      method: "POST",
      path,
      body,
    },
    tool: tool(config),
  });
}

async function generatedRows() {
  const r = await pg.query<{
    id: string;
    name: string;
    encrypted_data: string;
    iv: string;
    auth_tag: string;
  }>(
    `select id, name, encrypted_data, iv, auth_tag from secrets where category = 'generated' and deleted_at is null order by created_at`
  );
  return r.rows;
}
function decrypt(row: {
  id: string;
  encrypted_data: string;
  iv: string;
  auth_tag: string;
}) {
  return decryptServerSide(
    { encryptedData: row.encrypted_data, iv: row.iv, authTag: row.auth_tag },
    { column: "secrets.encrypted_data", rowId: row.id }
  );
}

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [schema.secrets, schema.secretAuditLog])
    await pg.exec(ddlFor(t as unknown as PgTable));
  holder.db = drizzle(pg, { schema });
});

beforeEach(async () => {
  await pg.exec(`delete from secret_audit_log; delete from secrets;`);
  // The provider token's own row (the handler reads its owner / pod-wide flag).
  await pg.exec(
    `insert into secrets (id, user_id, name, type, encrypted_data, iv, auth_tag) values ('${TOKEN_ID}', '${OWNER}', 'Vercel token', 'api_key', 'x', 'x', 'x')`
  );
  sent = [];
  holder.logCalls.length = 0;
  // Default provider: echoes the request body back (the worst case).
  respond = (body) =>
    new Response(JSON.stringify({ created: body }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ url: String(url), body });
      return respond(body);
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("vault://generate — minted on the server, kept, never returned", () => {
  it("fills the placeholder with a fresh value, keeps that same value encrypted, and scrubs it from the echoed result", async () => {
    const out = await call(OPTED_IN, {
      key: "AUTH_SECRET",
      value: PLACEHOLDER,
      type: "sensitive",
      target: ["production"],
    });
    expect(out.success).toBe(true);
    const value = (sent[0]!.body as { value: string }).value;
    expect(value).toMatch(HEX64);

    const rows = await generatedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe(NAME);
    expect(decrypt(rows[0]!)).toBe(value);
    const audit = await pg.query<{ action: string; metadata: any }>(
      `select action, metadata from secret_audit_log where secret_id = $1`,
      [rows[0]!.id]
    );
    expect(audit.rows).toEqual([
      {
        action: "created",
        metadata: { via: "generated-secret", tool: "vercel" },
      },
    ]);

    // The provider echoed the value: the caller sees only the marker.
    expect(JSON.stringify(out)).not.toContain(value);
    expect((out.body as any).created.value).toBe(GENERATED_SECRET_MARKER);
    expect((out.body as any).created.key).toBe("AUTH_SECRET");
  });

  it("scrubs the value from an error message, a header, a base64 echo and any depth", async () => {
    respond = (body) => {
      const v = (body as { value: string }).value;
      let deep: unknown = { v };
      for (let i = 0; i < 12; i++) deep = { deep };
      return new Response(
        JSON.stringify({
          error: { code: "bad", message: `value ${v} is not allowed` },
          b64: Buffer.from(v).toString("base64"),
          upper: v.toUpperCase(),
          deep,
        }),
        {
          status: 400,
          headers: { "content-type": "application/json", "x-echo": v },
        }
      );
    };
    const out = await call(OPTED_IN, { key: "K", value: PLACEHOLDER });
    const value = (sent[0]!.body as { value: string }).value;
    expect(out.success).toBe(false);
    const text = JSON.stringify(out);
    expect(text).not.toContain(value);
    expect(text).not.toContain(value.toUpperCase());
    expect(text).not.toContain(Buffer.from(value).toString("base64"));
    expect(out.error).toContain(GENERATED_SECRET_MARKER);
  });

  it("no log line carries the value", async () => {
    await call(OPTED_IN, { key: "K", value: PLACEHOLDER });
    const value = (sent[0]!.body as { value: string }).value;
    expect(JSON.stringify(holder.logCalls)).not.toContain(value);
  });

  it("one value per name within a call; another name gets its own", async () => {
    await call(OPTED_IN, {
      a: PLACEHOLDER,
      nested: [{ b: PLACEHOLDER }],
      other: "vault://generate?name=site:shop:OTHER&bytes=16",
    });
    const b = sent[0]!.body as any;
    expect(b.a).toMatch(HEX64);
    expect(b.nested[0].b).toBe(b.a);
    expect(b.other).toMatch(/^[0-9a-f]{32}$/);
    expect(await generatedRows()).toHaveLength(2);
  });

  it("generating the same name again rotates THAT row in place", async () => {
    await call(OPTED_IN, { value: PLACEHOLDER });
    await call(OPTED_IN, { value: PLACEHOLDER });
    const [first, second] = sent.map((s) => (s.body as any).value);
    expect(first).not.toBe(second);
    const rows = await generatedRows();
    expect(rows).toHaveLength(1);
    expect(decrypt(rows[0]!)).toBe(second);
  });

  it("never overwrites a row this door did not create, even with the same name and category", async () => {
    await pg.exec(
      `insert into secrets (id, user_id, name, type, category, encrypted_data, iv, auth_tag) values ('22222222-2222-4222-8222-222222222222', '${OWNER}', '${NAME}', 'password', 'generated', 'mine', 'mine', 'mine')`
    );
    await call(OPTED_IN, { value: PLACEHOLDER });
    const kept = await pg.query<{ encrypted_data: string }>(
      `select encrypted_data from secrets where id = '22222222-2222-4222-8222-222222222222'`
    );
    expect(kept.rows[0]!.encrypted_data).toBe("mine");
    expect(await generatedRows()).toHaveLength(2);
  });

  it("a tool that did not opt in sends the text as it is and mints nothing", async () => {
    await call({}, { value: PLACEHOLDER });
    expect((sent[0]!.body as any).value).toBe(PLACEHOLDER);
    expect(await generatedRows()).toHaveLength(0);
  });

  it("a placeholder in the path, or inside a longer string, is never filled", async () => {
    await call(OPTED_IN, { note: `see ${PLACEHOLDER}` }, `/x?v=${PLACEHOLDER}`);
    expect(sent[0]!.url).toContain("vault://generate");
    expect((sent[0]!.body as any).note).toBe(`see ${PLACEHOLDER}`);
    expect(await generatedRows()).toHaveLength(0);
  });

  it("a malformed placeholder sends nothing", async () => {
    const out = await call(OPTED_IN, {
      value: "vault://generate?name=bad name",
    });
    expect(out.success).toBe(false);
    expect(out.status).toBe(400);
    expect(out.error).toMatch(/^Nothing was sent/);
    expect(sent).toHaveLength(0);
    expect(await generatedRows()).toHaveLength(0);
    for (const bytes of ["8", "65", "x"]) {
      expect(
        parseGeneratePlaceholder(`vault://generate?name=a&bytes=${bytes}`)
      ).toHaveProperty("error");
    }
  });

  it("without a vault key nothing is sent — a value that cannot be kept is never used", async () => {
    const key = process.env.VAULT_SERVER_KEY;
    delete process.env.VAULT_SERVER_KEY;
    try {
      const out = await call(OPTED_IN, { value: PLACEHOLDER });
      expect(out.status).toBe(503);
      expect(sent).toHaveLength(0);
    } finally {
      process.env.VAULT_SERVER_KEY = key;
    }
  });
});
