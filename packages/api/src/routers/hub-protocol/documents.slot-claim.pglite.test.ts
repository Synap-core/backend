/**
 * Ticket 228ebe4b through the REAL create door: `synap_create_document` with
 * `expectedLabel` set to a slot's KEY ("claude-brief") instead of its label
 * ("Claude brief") was accepted, recorded under a name that matched no slot,
 * and said nothing — the later `completeOutput` claim then found no evidence.
 *
 * Driven through the Hub `documents.createDocument` (the door
 * `synap_create_document` and Hub REST both call) down to the REAL
 * `recordSessionArtifact` on PGlite: the assertions are on the stored
 * `artifacts` row and on the receipt the door returns.
 *
 * Stubbed, and why: the governance gate (`h.propose` picks auto-apply vs
 * proposal — the gate's own key rung is `permission-check.delegated-slot-claim`),
 * `@synap/storage` (an in-memory blob map), audit log, side effects, the
 * scoped-key middleware — not this seam.
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
import {
  artifacts,
  documents,
  documentVersions,
  focusSessions,
} from "@synap/database/schema";
import { documentsRouter as hubDocumentsRouter } from "./documents.js";

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

const SESSION = randomUUID();
const SLOTS = [
  { kind: "document", label: "Spec", key: "spec" },
  { kind: "document", label: "Claude brief", key: "claude-brief" },
];

async function hubCreate(expectedLabel: string) {
  return hubDocumentsRouter
    .createCaller({ userId: USER, scopes: [], sessionId: SESSION } as never)
    .createDocument({
      userId: USER,
      title: `Brief ${randomUUID().slice(0, 8)}`,
      content: "The brief.",
      expectedLabel,
    });
}

const warningsOf = (res: unknown) => (res as { warnings?: string[] }).warnings;

async function claimOf(documentId: string) {
  const { rows } = await h.client!.query<{ props: Record<string, unknown> }>(
    `select props from artifacts where ref_id = $1`,
    [documentId]
  );
  return rows[0]?.props;
}

beforeAll(async () => {
  for (const t of [documents, documentVersions, focusSessions, artifacts])
    await h.client!.exec(ddlFor(t as PgTable));
  await h.client!.query(
    `insert into focus_sessions (id, user_id, goal, status, expected_outputs)
     values ($1, $2, 'Write the brief', 'active', $3::jsonb)`,
    [SESSION, USER, JSON.stringify(SLOTS)]
  );
});

beforeEach(() => {
  h.propose = false;
  h.gate = [];
});

describe("create_document expectedLabel names a slot by key or label (228ebe4b)", () => {
  it("THE LIVE CASE: the slot's KEY fills that slot, with no warning", async () => {
    const res = await hubCreate("claude-brief");
    expect(res.status).toBe("created");
    expect(res).not.toHaveProperty("warnings");
    expect(await claimOf(res.documentId!)).toEqual({
      expectedLabel: "Claude brief",
      expectedKey: "claude-brief",
    });
  });

  it("the label still works as before", async () => {
    const res = await hubCreate("claude brief");
    expect(res).not.toHaveProperty("warnings");
    expect(await claimOf(res.documentId!)).toEqual({
      expectedLabel: "Claude brief",
      expectedKey: "claude-brief",
    });
  });

  it("a name matching no output is created, kept, and SAID on the receipt", async () => {
    const res = await hubCreate("brief");
    expect(res.status).toBe("created");
    expect(await claimOf(res.documentId!)).toEqual({ expectedLabel: "brief" });
    expect(warningsOf(res)).toEqual([
      'No output named "brief" on this session (outputs: spec — Spec; claude-brief — Claude brief): this write fills none of them. Name one by its key or its label.',
    ]);
  });

  it("a proposed create says it too", async () => {
    h.propose = true;
    const res = await hubCreate("brief");
    expect(res.status).toBe("proposed");
    expect(warningsOf(res)?.[0]).toMatch(/^No output named "brief"/);
  });
});
