/**
 * `synap_create_document` makes an HTML PAGE (`type: "html"`).
 *
 * Pod admin runs a stored `documents.type = "html"` at `/open/<id>` in an
 * isolated frame, and Hub REST / tRPC accepted `type`, but the agent's first
 * door, MCP `synap_create_document`, declared no `type`: an agent could not
 * make a page through MCP (the undeclared argument was refused) and nothing
 * in the tool text said a page runs. Found 5 Nov 2026 when an agent reached
 * for a cell proposal instead.
 *
 * Driven through the MCP handler into the REAL hub `documents.createDocument`
 * on PGlite: the assertions are on the stored `documents.type` and on the
 * receipt's `warnings` (the page diagnostics the hub door adds).
 *
 * Stubbed, and why: the governance gate (always auto-apply here; the gate has
 * its own tests), `@synap/storage` (an in-memory blob map), audit log, side
 * effects, the scoped-key middleware — not this seam.
 *
 * Not covered: the MCP door's undeclared-argument refusal (its own test scans
 * every `args.<key>` a handler reads against the declared schema).
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
// The pod-role check every tRPC mutation runs first (no sync table here).
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { documents, documentVersions } from "@synap/database/schema";
import { documentsRouter as hubDocumentsRouter } from "../../hub-protocol/documents.js";
import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const USER = randomUUID();

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
async function mcpCreate(args: Record<string, unknown>) {
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
  } as unknown as McpToolContext)) as { content: Array<{ text?: string }> };
  return JSON.parse(result.content[0]!.text!) as {
    status?: string;
    documentId?: string;
    warnings?: string[];
  };
}

async function storedType(id: string) {
  const { rows } = await h.client!.query<{ type: string }>(
    `select type from documents where id = $1`,
    [id]
  );
  return rows[0]?.type;
}

const PAGE_WITH_CDN = `<!doctype html><html><head>
<script src="https://cdn.example.com/chart.js"></script>
</head><body><h1>Report</h1></body></html>`;

beforeAll(async () => {
  for (const t of [documents, documentVersions])
    await h.client!.exec(ddlFor(t as PgTable));
});

describe("synap_create_document — type html makes a page", () => {
  it("THE LIVE CASE: type html is stored as html, and the receipt says the CDN script will not run", async () => {
    const res = await mcpCreate({
      title: "Weekly report",
      content: PAGE_WITH_CDN,
      type: "html",
    });
    expect(res.status).toBe("created");
    expect(await storedType(res.documentId!)).toBe("html");
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings![0]).toMatch(
      /^This page loads code from cdn\.example\.com\. Pages run with no network/
    );
  });

  it("an inline page is stored as html with no warning", async () => {
    const res = await mcpCreate({
      title: "Inline page",
      content: "<!doctype html><p>Hello</p><script>document.title='x'</script>",
      type: "html",
    });
    expect(await storedType(res.documentId!)).toBe("html");
    expect(res).not.toHaveProperty("warnings");
  });

  it("no type is a markdown document, as before (the same html text is not diagnosed)", async () => {
    const res = await mcpCreate({
      title: "Notes about a page",
      content: PAGE_WITH_CDN,
    });
    expect(await storedType(res.documentId!)).toBe("markdown");
    expect(res).not.toHaveProperty("warnings");
  });

  it("a type other than markdown or html is refused before anything is written", async () => {
    const { rows: before } = await h.client!.query<{ n: number }>(
      `select count(*)::int as n from documents`
    );
    await expect(
      mcpCreate({ title: "A pdf?", content: "x", type: "pdf" })
    ).rejects.toThrow(/`type` must be "markdown" or "html"/);
    const { rows: after } = await h.client!.query<{ n: number }>(
      `select count(*)::int as n from documents`
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
