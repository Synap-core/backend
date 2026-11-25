/**
 * `synap_create_document({ entityId })` files the new body where its entity
 * lives (a part follows its whole, founder decision 22226da5, 2026-11-09).
 *
 * The live case: an agent wrote a composition's body with no workspace; the
 * entity was in Content OS, the body landed pod-wide, and the Content Studio
 * key (limited to Content OS) got not_found on it.
 *
 * Driven through the MCP handler, the REAL preflight (`preflightAttachToEntity`,
 * the entity write floor on PGlite) and the REAL hub `documents.createDocument`
 * on PGlite: the assertions are on the stored `documents.workspace_id` and on
 * the receipt's `warnings`.
 *
 * Stubbed, and why: the governance gate (always auto-apply; it has its own
 * tests), the attach step (`attachCreatedDocument` — a governed entity update,
 * covered by the attach door's tests; here it passes the receipt through),
 * `@synap/storage` (in-memory), audit log, side effects, the scoped-key
 * middleware.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  blobs: new Map<string, string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
  };
});

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (u: string, k: string, id: string, ext: string) =>
      `${u}/${k}/${id}.${ext}`,
    upload: async (key: string, body: string | Buffer) => {
      const text = Buffer.isBuffer(body) ? body.toString("utf-8") : body;
      h.blobs.set(key, text);
      const checksum = `sha256:${createHash("sha256").update(text).digest("hex")}`;
      return { url: key, path: key, size: text.length, checksum };
    },
    downloadBuffer: async (key: string) =>
      Buffer.from(h.blobs.get(key) ?? "", "utf-8"),
  },
}));

vi.mock("../../hub-protocol/attach-created-document.js", () => ({
  attachCreatedDocument: async (input: { created: unknown }) => input.created,
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));
vi.mock("../../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../middleware/api-key-auth.js")
    >();
  const { t } =
    await vi.importActual<typeof import("../../../trpc.js")>(
      "../../../trpc.js"
    );
  return { ...actual, scopedProcedure: () => t.procedure };
});
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { documentsRouter as hubDocumentsRouter } from "../../hub-protocol/documents.js";
import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const USER = randomUUID();
const CONTENT = randomUUID(); // the entity's space
const LENS = randomUUID(); // another space the caller is in (the URL lens)
const HOME = randomUUID(); // a pod-wide entity's home
const KIND = randomUUID();
const E_CONTENT = randomUUID(); // stored in CONTENT
const E_HOMED = randomUUID(); // pod-wide, filed for HOME
const E_POD = randomUUID(); // pod-wide, no home

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    let def = "";
    if (c.hasDefault) {
      if (typeof c.default === "number" || typeof c.default === "boolean")
        def = ` default ${c.default}`;
      else if (typeof c.default === "string")
        def = ` default '${c.default.replace(/'/g, "''")}'`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
      else if (type === "jsonb") def = ` default '{}'::jsonb`;
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const createDocument = entityHandlers.synap_create_document!;

/** The MCP call, with the REAL hub documents router as its caller. */
async function mcpCreate(
  args: Record<string, unknown>,
  extra: Partial<McpToolContext> = {}
) {
  const caller = {
    documents: hubDocumentsRouter.createCaller({
      userId: USER,
      scopes: [],
    } as never),
  };
  const result = (await createDocument({
    toolName: "synap_create_document",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    caller,
    lensCaller: caller,
    workspaceAccessible: false,
    ...extra,
  } as unknown as McpToolContext)) as { content: Array<{ text?: string }> };
  return JSON.parse(result.content[0]!.text!) as {
    status?: string;
    documentId?: string;
    warnings?: string[];
  };
}

async function storedSpace(id: string) {
  const { rows } = await h.client!.query<{ workspace_id: string | null }>(
    `select workspace_id from documents where id = $1`,
    [id]
  );
  return rows[0]?.workspace_id;
}

async function documentCount() {
  const { rows } = await h.client!.query<{ n: number }>(
    `select count(*)::int as n from documents`
  );
  return rows[0]!.n;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    USER,
    "person@example.test",
  ]);
  for (const ws of [CONTENT, LENS, HOME]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'Space',$2,'{}'::jsonb)`,
      [ws, USER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, USER]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id) values ($1,'content-composition','Composition','kind','system',null)`,
    [KIND]
  );
  for (const [id, ws, home] of [
    [E_CONTENT, CONTENT, null],
    [E_HOMED, null, HOME],
    [E_POD, null, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, home_workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,$5,'content-composition','Composition','{}'::jsonb,'{}'::jsonb)`,
      [id, USER, ws, home, KIND]
    );
  }
}, 120_000);

describe("synap_create_document({ entityId }) — the body is filed with its entity", () => {
  it("THE LIVE CASE: no workspace requested, entity in Content OS → the body is stored in Content OS", async () => {
    const res = await mcpCreate({
      entityId: E_CONTENT,
      title: "Carousel composition",
      content: "Layered composition of the carousel.",
    });
    expect(res.status).toBe("created");
    expect(await storedSpace(res.documentId!)).toBe(CONTENT);
    expect(res.warnings ?? []).toEqual([]);
  });

  it("a lens on another space does not win: filed in the entity's space, and the receipt says so", async () => {
    const res = await mcpCreate(
      {
        entityId: E_CONTENT,
        title: "Second take",
        content: "Another body.",
        replaceBody: true,
      },
      { requestedWorkspaceId: LENS, lensWorkspaceId: LENS }
    );
    expect(res.status).toBe("created");
    expect(await storedSpace(res.documentId!)).toBe(CONTENT);
    expect(res.warnings?.some((w) => w.includes(CONTENT))).toBe(true);
  });

  it("a pod-wide entity filed for a space → the body goes to that space", async () => {
    const res = await mcpCreate({
      entityId: E_HOMED,
      title: "Homed body",
      content: "Text.",
    });
    expect(await storedSpace(res.documentId!)).toBe(HOME);
  });

  it("a pod-wide entity with no home keeps today's placement (the requested space, or pod-wide)", async () => {
    const none = await mcpCreate({
      entityId: E_POD,
      title: "Pod body",
      content: "Text.",
    });
    expect(await storedSpace(none.documentId!)).toBeNull();
    const lensed = await mcpCreate(
      {
        entityId: E_POD,
        title: "Pod body 2",
        content: "Text 2.",
        replaceBody: true,
      },
      { requestedWorkspaceId: LENS, lensWorkspaceId: LENS }
    );
    expect(await storedSpace(lensed.documentId!)).toBe(LENS);
  });

  it("a key BOUND to another space is refused before anything is written", async () => {
    const before = await documentCount();
    await expect(
      mcpCreate(
        {
          entityId: E_CONTENT,
          title: "Escaping body",
          content: "Text.",
          replaceBody: true,
        },
        {
          keyType: "service",
          keyWorkspaceId: LENS,
          requestedWorkspaceId: LENS,
        }
      )
    ).rejects.toThrow(/confined/);
    expect(await documentCount()).toBe(before);
  });

  it("without entityId nothing changes: the requested space, or pod-wide", async () => {
    const res = await mcpCreate({ title: "Loose", content: "Loose text." });
    expect(await storedSpace(res.documentId!)).toBeNull();
  });
});
