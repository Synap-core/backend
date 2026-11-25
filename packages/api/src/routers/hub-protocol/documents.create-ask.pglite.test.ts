/**
 * The hub CREATE door materializes an agent's question definition: the body
 * lands in the REFERENCE form and the question is filed on the author's session
 * (`services/document-patch/materialize-asks.ts`). The materializer runs REAL
 * (parse, validate, rewrite, refusals); only its slot port is a fake, since
 * the real slot door has its own suites. Rows and blobs are the REAL create
 * door on PGlite.
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
  askSlots: [] as Array<Record<string, unknown>>,
  askSession: "active" as string | null,
  deny: false,
  atCap: false,
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
  refuseAtAgentPendingCap: vi.fn(async () =>
    h.atCap ? { denied: true, reason: "proposal cap reached" } : null
  ),
  previewPermissionDecision: vi.fn(async () =>
    h.deny
      ? { decision: "deny" as const, reason: "denied by rule" }
      : { decision: h.propose ? ("propose" as const) : ("execute" as const) }
  ),
  checkPermissionOrPropose: vi.fn(
    async (opts: { data?: Record<string, unknown> }) => {
      h.gate.push(opts.data ?? {});
      if (h.deny) return { denied: true, reason: "denied by rule" };
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
// The ask materializer runs REAL; only its session side is a fake (the real
// slot door has its own suite, `materialize-asks.pglite.test.ts`).
vi.mock("../../services/document-patch/ask-slots.js", () => ({
  readAskSession: async () =>
    h.askSession === null
      ? null
      : { status: h.askSession, expectedOutputs: h.askSlots },
  buildAskSlot: async (spec: Record<string, unknown>) => ({
    kind: "ask",
    owner: "human",
    ...spec,
  }),
  fileAskSlots: async (a: { slots: Array<Record<string, unknown>> }) => {
    h.askSlots.push(...a.slots);
    return { status: "updated" as const };
  },
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { documents, documentVersions } from "@synap/database/schema";
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

/** The stored row's body. */
async function stored(id: string) {
  const { rows } = await h.client!.query<{ storage_key: string }>(
    `select storage_key from documents where id = $1`,
    [id]
  );
  return h.blobs.get(rows[0]!.storage_key);
}

const SESSION = "6f1c2b0e-0a52-4c4e-9d33-2d6c0f6d9a11";
const ASK = JSON.stringify({
  key: "which-database",
  label: "Which database?",
  ask: {
    mode: "choose",
    options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
  },
});
const DEFINITION = [
  ":::synap-ask",
  "```json",
  ASK,
  "```",
  "",
  "Which database?",
  ":::",
].join("\n");

function create(
  ctx: Record<string, unknown>,
  content = `Plan.\n\n${DEFINITION}\n`
) {
  return hubDocumentsRouter
    .createCaller({ userId: USER, scopes: [], ...ctx } as never)
    .createDocument({ userId: USER, title: "Ask plan", content });
}
/** A call as the REST door makes it: `sessionId` as named, `ambientSessionId` as verified. */
const agent = (ctx: Record<string, unknown> = {}) => ({
  agentUserId: "agent-1",
  sessionId: SESSION,
  ambientSessionId: SESSION,
  ...ctx,
});

beforeAll(async () => {
  for (const t of [documents, documentVersions])
    await h.client!.exec(ddlFor(t as PgTable));
});

beforeEach(async () => {
  // A clean table: the content-hash idempotency window would otherwise answer a
  // later test with an earlier test's row.
  await h.client!.exec("delete from documents");
  h.propose = false;
  h.deny = false;
  h.atCap = false;
  h.gate = [];
  h.askSlots = [];
  h.askSession = "active";
});

const documentCount = async () =>
  (
    await h.client!.query<{ n: number }>(
      `select count(*)::int as n from documents`
    )
  ).rows[0]!.n;

describe("hub documents.createDocument — an agent's question definition", () => {
  it("lands as the REFERENCE form, with the slot filed on the author's session", async () => {
    const res = await create(agent());
    expect(res.status).toBe("created");
    const body = await stored(res.documentId!);
    expect(body).toContain(`sessionId="${SESSION}"`);
    expect(body).toContain(`slot="which-database"`);
    expect(body).not.toContain("```json");
    expect(h.askSlots).toHaveLength(1);
  });

  it("a replay of the same write dedupes and files nothing more", async () => {
    const a = await create(agent());
    const b = await create(agent());
    expect(b).toMatchObject({
      ackState: "duplicate-ignored",
      documentId: a.documentId,
    });
    expect(h.askSlots).toHaveLength(1);
  });

  it("a proposed create carries the rewritten body and exactly one slot", async () => {
    h.propose = true;
    const res = await create(agent());
    expect(res.status).toBe("proposed");
    expect(String(h.gate[0]!.content)).toContain(`slot="which-database"`);
    expect(String(h.gate[0]!.content)).not.toContain("```json");
    expect(h.askSlots).toHaveLength(1);
  });

  it("DENIED by governance: no slot is filed and no row is stored", async () => {
    h.deny = true;
    await expect(create(agent())).rejects.toThrow(/denied by rule/);
    expect(h.askSlots).toEqual([]);
    expect(await documentCount()).toBe(0);
  });

  it("an agent AT its proposal cap: refused before filing, no slot, no row", async () => {
    h.propose = true;
    h.atCap = true;
    await expect(create(agent())).rejects.toThrow(/proposal cap reached/);
    expect(h.askSlots).toEqual([]);
    expect(await documentCount()).toBe(0);
  });

  it("no verified session (a body-named one only): refused with the fix, no row", async () => {
    await expect(
      create({
        agentUserId: "agent-1",
        sessionId: SESSION,
        ambientSessionId: null,
      })
    ).rejects.toThrow(/synap_start_session/);
    expect(await documentCount()).toBe(0);
    expect(h.askSlots).toEqual([]);
  });

  it("a named session that differs from the verified one is refused", async () => {
    await expect(
      create(agent({ sessionId: "0a0a0a0a-0a52-4c4e-9d33-2d6c0f6d9a11" }))
    ).rejects.toThrow(/names session 0a0a0a0a/);
    expect(h.askSlots).toEqual([]);
  });

  it("a person's create is stored as written", async () => {
    const res = await create({});
    expect(await stored(res.documentId!)).toContain("```json");
    expect(h.askSlots).toEqual([]);
  });

  it("a url document and a non-markdown type are left untouched", async () => {
    const html = await hubDocumentsRouter
      .createCaller({ userId: USER, scopes: [], ...agent() } as never)
      .createDocument({
        userId: USER,
        title: "Page",
        content: DEFINITION,
        type: "html",
      });
    expect(await stored(html.documentId!)).toContain("```json");
    await hubDocumentsRouter
      .createCaller({ userId: USER, scopes: [], ...agent() } as never)
      .createDocument({
        userId: USER,
        title: "Linked",
        content: DEFINITION,
        url: "https://example.test/x",
      });
    expect(h.askSlots).toEqual([]);
  });
});
