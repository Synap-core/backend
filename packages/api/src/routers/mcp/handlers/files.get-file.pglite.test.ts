/**
 * `synap_get_file` (ticket 66e66dce) — through the REAL handler, the REAL
 * `signFileEntityUrl` → `loadSignableFileEntity` → `scopedDb(entities)` (the
 * key's grant ANDed by the registered grant read provider), compiled and run
 * as SQL on PGlite, under `runWithGrant` as the MCP door enters it. Stubbed:
 * the object store (`getSignedUrl` echoes the key; `downloadBuffer` returns
 * known bytes).
 *
 * Rows rule out: a file read that skips the grant (the out-of-grant file
 * would be signed), a bare 403 that does not say which floor refused (the
 * key's grant vs the person), an image an agent cannot see (no `image`
 * block), a PDF or an over-size image pushed inline, and inline:false
 * ignored.
 *
 * Cannot see: production Postgres, a real signer, a real MCP client drawing
 * the image block.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  bytes: Buffer.from("png-bytes"),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    getSignedUrl: async (key: string, expiresIn: number) =>
      `https://signed.test/${key}?expires=${expiresIn}`,
    downloadBuffer: async () => h.bytes,
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { fileHandlers, INLINE_IMAGE_MAX_BYTES } from "./files.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // the person the key acts for
const OTHER = randomUUID(); // someone else on the pod
const AGENT = randomUUID();
const WS_A = randomUUID(); // the space the key's grant covers
const WS_B = randomUUID(); // another of the owner's spaces — NOT granted
const WS_C = randomUUID(); // OTHER's space; the owner is not a member
const FILE_PROFILE = randomUUID();
const PNG_A = randomUUID();
const PDF_A = randomUUID();
const BIG_A = randomUUID();
const PNG_B = randomUUID();
const PNG_C = randomUUID();

/** The app-connect shape: read-only, pinned to one space. */
const PINNED = {
  scopes: [{ permissions: ["entity.*.read"], workspaceIds: [WS_A] }],
  clientId: null,
};

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, user_type) values ($1,$2,'human'),($3,$4,'human')`,
    [OWNER, "owner@example.test", OTHER, "other@example.test"]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  for (const [ws, member] of [
    [WS_A, OWNER],
    [WS_B, OWNER],
    [WS_C, OTHER],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, `ws-${ws.slice(0, 4)}`, member]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, member]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'file','File','kind','system','workspace',true,'{}'::jsonb,null)`,
    [FILE_PROFILE]
  );
  for (const [entityId, owner, ws, key, mime, size] of [
    [PNG_A, OWNER, WS_A, "users/owner/board.png", "image/png", 9],
    [PDF_A, OWNER, WS_A, "users/owner/brief.pdf", "application/pdf", 9],
    [
      BIG_A,
      OWNER,
      WS_A,
      "users/owner/big.png",
      "image/png",
      INLINE_IMAGE_MAX_BYTES + 1,
    ],
    [PNG_B, OWNER, WS_B, "users/owner/b.png", "image/png", 9],
    [PNG_C, OTHER, WS_C, "users/other/c.png", "image/png", 9],
  ] as const) {
    const docId = randomUUID();
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type, size)
       values ($1,$2,$3,'f','file',$4,$5,$6)`,
      [docId, owner, ws, key, mime, size]
    );
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, document_id)
       values ($1,$2,$3,$4,'file',$5,'{}'::jsonb,'{}'::jsonb,$6)`,
      [entityId, owner, ws, FILE_PROFILE, key.split("/").pop(), docId]
    );
  }
}, 120_000);

type Reply = {
  isError?: boolean;
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
};

const getFile = (
  args: Record<string, unknown>,
  grant: typeof PINNED | null = PINNED
): Promise<Reply> => {
  const call = () =>
    fileHandlers.synap_get_file!({
      toolName: "synap_get_file",
      args,
      userId: OWNER,
      apiKeyScopes: ["mcp.read"],
      agentUserId: AGENT,
    } as never) as Promise<Reply>;
  return grant ? runWithGrant(grant as never, call) : call();
};
const json = (r: Reply) =>
  JSON.parse((r.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;

describe("synap_get_file — a signed URL, and a small image an agent can see", () => {
  it("an in-grant PNG ⇒ the URL of THAT blob, and the bytes as an image block", async () => {
    const r = await getFile({ entityId: PNG_A });
    expect(r.isError).toBeFalsy();
    const body = json(r);
    expect(body).toMatchObject({
      entityId: PNG_A,
      mimeType: "image/png",
      size: 9,
      url: "https://signed.test/users/owner/board.png?expires=900",
      inline: { sent: true },
    });
    expect(r.content[1]).toEqual({
      type: "image",
      data: h.bytes.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("a PDF ⇒ the link only, and why it was not sent inline", async () => {
    const r = await getFile({ entityId: PDF_A });
    expect(r.content).toHaveLength(1);
    expect(json(r)).toMatchObject({
      url: "https://signed.test/users/owner/brief.pdf?expires=900",
      inline: { sent: false },
    });
    expect(String((json(r).inline as { why: string }).why)).toMatch(/PNG/);
  });

  it("an image over the inline cap ⇒ the link only", async () => {
    const r = await getFile({ entityId: BIG_A });
    expect(r.content).toHaveLength(1);
    expect((json(r).inline as { why: string }).why).toMatch(/too large/);
  });

  it("inline:false ⇒ the link only", async () => {
    const r = await getFile({ entityId: PNG_A, inline: false });
    expect(r.content).toHaveLength(1);
    expect(json(r).inline).toMatchObject({ sent: false });
  });

  it("a file outside the key's grant ⇒ refused, and the refusal names the grant", async () => {
    const r = await getFile({ entityId: PNG_B });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/outside what this key's grant reaches/);
    expect(text).toContain("refusedBy: key_grant");
    expect(text).not.toContain("signed.test");
  });

  it("control: the same file IS signed with no grant in force (the person reads it)", async () => {
    const r = await getFile({ entityId: PNG_B }, null);
    expect(r.isError).toBeFalsy();
    expect(json(r).url).toBe(
      "https://signed.test/users/owner/b.png?expires=900"
    );
  });

  it("a file the person cannot read ⇒ refused, and the refusal names the person", async () => {
    for (const grant of [PINNED, null]) {
      const r = await getFile({ entityId: PNG_C }, grant);
      expect(r.isError).toBe(true);
      const text = (r.content[0] as { text: string }).text;
      expect(text).toContain("refusedBy: person");
      expect(text).not.toContain("signed.test");
    }
  });

  it("a shortened id ⇒ the full-UUID error, nothing read", async () => {
    const r = await getFile({ entityId: PNG_A.slice(0, 8) });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/36-character/);
  });
});
