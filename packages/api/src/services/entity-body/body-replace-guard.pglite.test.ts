/**
 * An entity's body is never replaced SILENTLY (task 221e0674, 2026-10-20):
 * `synap_create_document({ entityId })` replaced a decision's foundation
 * document with no warning, and the old document then hung off nothing.
 *
 * Driven through the real doors on PGlite, every table from the schema:
 *  1. `entities.update({ documentId })` — where every attach converges — is
 *     refused (CONFLICT, naming the body) unless `replaceBody: true`; a source
 *     file attached as provenance is not a body;
 *  2. the MCP `synap_create_document` door refuses BEFORE the document is
 *     created (no orphan), and passes with `replaceBody: true`;
 *  3. a capture plan's `create_document` step is refused at preflight.
 *
 * Stubbed: the permission gate (a recorder that files a proposal — reaching it
 * proves the guard let the call through), event/audit fan-out, profiles.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  perm: undefined as unknown as import("vitest").Mock,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    registerIdentitySignals: async () => undefined,
    getDb: async () => holder.db,
    eventRepository: { append: async () => undefined },
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return null;
      }
      async resolveProfile(slug: string) {
        return { id: randomUUID(), slug, profileKind: "kind" };
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: (...a: unknown[]) => holder.perm(...a),
}));
vi.mock("../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";

const USER = randomUUID();
let client: PGlite;

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

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  await client.query(`insert into users (id, email) values ($1, $2)`, [
    USER,
    "owner@example.test",
  ]);
  holder.db = drizzle(client, { schema });
}, 120_000);

async function insertDocument(title: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into documents (id, user_id, workspace_id, title, type) values ($1,$2,null,$3,'markdown')`,
    [id, USER, title]
  );
  return id;
}

async function insertEntity(
  documentId: string | null,
  properties: Record<string, unknown> = {}
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, workspace_id, type, title, document_id, properties)
     values ($1,$2,null,'decision','Foundation decision',$3,$4::jsonb)`,
    [id, USER, documentId, JSON.stringify(properties)]
  );
  return id;
}

async function bodyOf(entityId: string): Promise<string | null> {
  const { rows } = await client.query<{ document_id: string | null }>(
    `select document_id from entities where id = $1`,
    [entityId]
  );
  return rows[0]?.document_id ?? null;
}

async function entitiesCaller() {
  const { entitiesRouter } = await import("../../routers/entities.js");
  return entitiesRouter.createCaller({
    db: holder.db,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);
}

const proposes = () =>
  vi.fn(async () => ({
    proposalId: "prop-1",
    proposalType: "update",
    reviewUrl: "https://pod.example/open/prop-1",
  }));

describe("entities.update — attaching a document never replaces a body silently", () => {
  it("refuses a new documentId over an existing body, naming it, before the gate", async () => {
    const body = await insertDocument("Foundation");
    const entityId = await insertEntity(body);
    const next = await insertDocument("Meeting notes");
    holder.perm = proposes();
    const caller = await entitiesCaller();
    await expect(
      caller.update({ id: entityId, documentId: next })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(
        `already has a body: document ${body} "Foundation"`
      ),
    });
    // It names the related-document path, not just "no".
    await expect(
      caller.update({ id: entityId, documentId: next })
    ).rejects.toThrow(/synap_link_entities/);
    expect(holder.perm).not.toHaveBeenCalled();
    expect(await bodyOf(entityId)).toBe(body);
  });

  it("lets `replaceBody: true` through to the governed write", async () => {
    const entityId = await insertEntity(await insertDocument("Foundation"));
    const next = await insertDocument("New foundation");
    holder.perm = proposes();
    const caller = await entitiesCaller();
    const out = await caller.update({
      id: entityId,
      documentId: next,
      replaceBody: true,
    });
    expect(out).toMatchObject({ status: "proposed" });
    expect(holder.perm).toHaveBeenCalledTimes(1);
  });

  it("does not count a source file attached as provenance as a body", async () => {
    const blob = await insertDocument("scan.pdf");
    const entityId = await insertEntity(blob, { sourceFileDocumentId: blob });
    holder.perm = proposes();
    const caller = await entitiesCaller();
    const out = await caller.update({
      id: entityId,
      documentId: await insertDocument("The write-up"),
    });
    expect(out).toMatchObject({ status: "proposed" });
  });

  it("attaches a first body with no flag", async () => {
    const entityId = await insertEntity(null);
    holder.perm = proposes();
    const caller = await entitiesCaller();
    const out = await caller.update({
      id: entityId,
      documentId: await insertDocument("First body"),
    });
    expect(out).toMatchObject({ status: "proposed" });
  });
});

describe("synap_create_document({ entityId }) — refused before a document exists", () => {
  async function run(args: Record<string, unknown>) {
    const { entityHandlers } =
      await import("../../routers/mcp/handlers/entity.js");
    const createDocument = vi.fn(async () => ({
      // A gated document: the attach step then reports "skipped" without
      // touching the entity, so this test stays on the preflight seam.
      status: "proposed",
      proposalId: "doc-prop",
      documentId: randomUUID(),
    }));
    const call = entityHandlers.synap_create_document!({
      toolName: "synap_create_document",
      args,
      userId: USER,
      apiKeyScopes: ["mcp.read", "mcp.write"],
      caller: { documents: { createDocument } },
    } as never);
    return { call, createDocument };
  }

  it("creates nothing when the entity already has a body", async () => {
    const body = await insertDocument("Foundation");
    const entityId = await insertEntity(body);
    const { rows: before } = await client.query<{ n: number }>(
      `select count(*)::int as n from documents`
    );
    const { call, createDocument } = await run({
      title: "Notes",
      content: "x",
      entityId,
    });
    await expect(call).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining(`document ${body} "Foundation"`),
    });
    expect(createDocument).not.toHaveBeenCalled();
    const { rows: after } = await client.query<{ n: number }>(
      `select count(*)::int as n from documents`
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("goes ahead with replaceBody: true", async () => {
    const entityId = await insertEntity(await insertDocument("Foundation"));
    const { call, createDocument } = await run({
      title: "New foundation",
      content: "x",
      entityId,
      replaceBody: true,
    });
    await expect(call).resolves.toBeDefined();
    expect(createDocument).toHaveBeenCalledTimes(1);
  });
});

describe("capture plan — a create_document step over a body is a preflight problem", () => {
  it("names the existing body on the step", async () => {
    const { preflightPlanOperations } =
      await import("../capture-agent/capture-plan-preflight.js");
    const body = await insertDocument("Foundation");
    const entityId = await insertEntity(body);
    const free = await insertEntity(null);
    const { problems } = await preflightPlanOperations(
      holder.db as never,
      [
        {
          op: "create_document",
          ref: "d1",
          title: "N",
          content: "x",
          entityId,
        },
        {
          op: "create_document",
          ref: "d2",
          title: "N",
          content: "x",
          entityId: free,
        },
      ],
      USER,
      { workspaceId: null }
    );
    const mine = problems.filter((p) => /already has a body/.test(p.message));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ opIndex: 0, ref: "d1" });
    expect(mine[0]!.message).toContain(`document ${body} "Foundation"`);
  });
});
