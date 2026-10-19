/**
 * ONE TITLE through the REAL create door (founder 2026-10-19): a document's
 * NAME is its one title, so a body that OPENS with a heading equal to it is
 * stored without that heading. Driven through the Hub `documents.createDocument`
 * (the door `synap_create_document` and Hub REST both call) and the
 * `documents.upload` door, down to the REAL `createDocumentWithContent` on
 * PGlite: the assertion is on the stored ROW and the stored BLOB, never on a
 * hand-built object.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` — `h.propose` decides auto-apply vs proposal and
 *    the call's `data` is recorded: the seam here is WHICH content the door
 *    hands the gate (what a person reviews) and WHICH content lands.
 *  - `@synap/storage` — an in-memory blob map with the real checksum shape.
 *  - audit log, side effects, the scoped-key middleware — not this seam.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  blobs: new Map<string, string>(),
  propose: false,
  gate: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
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

vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(
    async (opts: { data?: Record<string, unknown> }) => {
      h.gate.push(opts.data ?? {});
      if (!h.propose) return { granted: true };
      return {
        granted: false,
        proposalId: "prop-1",
        proposalType: "document.create",
        summary: "s",
        reasoning: "r",
        reviewPath: "/open/prop-1",
        reviewUrl: "https://pod/open/prop-1",
      };
    }
  ),
}));
vi.mock("../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../middleware/api-key-auth.js")>();
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return { ...actual, scopedProcedure: () => t.procedure };
});
vi.mock("../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
// The pod-role check every tRPC mutation runs first (no sync table here).
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { documents, documentVersions } from "@synap/database/schema";
import { documentsRouter as hubDocumentsRouter } from "./documents.js";
import { documentsRouter } from "../documents.js";
import { stageIntakeSource } from "../../services/intake/stage-intake-source.js";

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

/** The stored row and the body its storage key holds. */
async function stored(id: string) {
  const { rows } = await h.client!.query<{
    title: string;
    storage_key: string;
  }>(`select title, storage_key from documents where id = $1`, [id]);
  const row = rows[0]!;
  return { title: row.title, body: h.blobs.get(row.storage_key) };
}

async function hubCreate(input: {
  title: string;
  content: string;
  type?: "markdown" | "html";
}) {
  return hubDocumentsRouter
    .createCaller({ userId: USER, scopes: [] } as never)
    .createDocument({ userId: USER, ...input });
}

beforeAll(async () => {
  for (const t of [documents, documentVersions])
    await h.client!.exec(ddlFor(t as PgTable));
});

beforeEach(() => {
  h.propose = false;
  h.gate = [];
});

describe("hub documents.createDocument — one title", () => {
  it("a body opening with `# <name>` is stored without it; the name stays the title", async () => {
    const res = await hubCreate({
      title: "Launch plan",
      content: "# Launch plan\n\nShip on Friday.\n",
    });
    expect(res.status).toBe("created");
    expect(await stored(res.documentId!)).toEqual({
      title: "Launch plan",
      body: "Ship on Friday.\n",
    });
  });

  it("a heading that differs from the name is content, and stays", async () => {
    const res = await hubCreate({
      title: "Pinned surfaces — spec",
      content: "# Pinned surfaces\n\nA pin.\n",
    });
    expect((await stored(res.documentId!)).body).toBe(
      "# Pinned surfaces\n\nA pin.\n"
    );
  });

  it("a proposed create carries the body without the name — what is reviewed is what lands", async () => {
    h.propose = true;
    const res = await hubCreate({
      title: "Launch plan",
      content: "## LAUNCH plan\n\nShip on Monday instead.\n",
    });
    expect(res.status).toBe("proposed");
    expect(h.gate[0]).toMatchObject({
      title: "Launch plan",
      content: "Ship on Monday instead.\n",
    });
  });

  it("an HTML document is stored as sent (only markdown has headings to read)", async () => {
    const html = "# Launch plan\n<p>x</p>";
    const res = await hubCreate({ title: "Launch plan", content: html, type: "html" });
    expect((await stored(res.documentId!)).body).toBe(html);
  });
});

describe("documents.upload — no name given", () => {
  it("a markdown upload with no title is named by its leading `# `, which leaves the body", async () => {
    const res = await documentsRouter
      .createCaller({ userId: USER, authenticated: true, db: h.db } as never)
      .upload({ type: "markdown", content: "# Weekly review\n\nDone.\n" });
    expect(await stored(res.documentId)).toEqual({
      title: "Weekly review",
      body: "Done.\n",
    });
  });
});

describe("intake — a captured source is its raw", () => {
  // A re-structure REPLAYS the stored source, so the one-title rule never
  // drops its first line (the name may come from it). Readers skip the
  // duplicate heading at display time instead.
  it("the stored raw keeps its opening heading byte for byte", async () => {
    const text = "# Call with Inès\n\nWants the portal before January.";
    const { documentId } = await stageIntakeSource({
      database: h.db as never,
      userId: USER,
      sessionId: null,
      door: "test",
      kind: "text",
      text,
    });
    expect(await stored(documentId)).toEqual({
      title: "Call with Inès",
      body: text,
    });
  });
});
