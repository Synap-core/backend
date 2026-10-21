/**
 * A PROPOSED body attach applies on approval, and Undo puts the previous body
 * back (decision B9g).
 *
 * THE DEFECT (fb1020-docs §1): `entities.update` stored `documentId` in the
 * proposal, but the approval replay (`applyApprovedEntityPatch`) never passed
 * it on — the proposal approved and the body was NOT attached ("approved,
 * changed nothing"). A replacement also lost `replaceBody`, so the body guard
 * would have refused it at approval. And no undo record covered a body change.
 *
 * Driven through the real doors on PGlite, every table from the schema:
 *  - propose: `entities.update` as an agent (the gate is a recorder that files
 *    a proposal for an agent and grants the human approver);
 *  - approve: the real `entity/update` executor → `entities.update` →
 *    `stampEntityUpdate`;
 *  - undo: the real `proposals.revert` → `revertProposalCreations` →
 *    `safeRevert` compare-and-restore;
 *  - the agent door: MCP `synap_update_entity({ documentId })` → the real hub
 *    caller → `entities.update`.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  gateCalls: [] as Array<Record<string, unknown>>,
  receiptId: null as string | null,
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
// The gate's DECISION has its own suites; this recorder files a proposal for
// an agent and grants a human (the approver's replay), naming a receipt when
// a test sets one (the auto-approved path).
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async (args: Record<string, unknown>) => {
    holder.gateCalls.push(args);
    if (args.agentUserId && !holder.receiptId) {
      return {
        proposalId: randomUUID(),
        proposalType: "update",
        reviewUrl: "https://pod.example/open/p",
      };
    }
    return holder.receiptId
      ? { granted: true, autoApprovedProposalId: holder.receiptId }
      : { granted: true };
  }),
}));
vi.mock(
  "../../routers/proposals/review-authority.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    computeCanReviewApproval: vi.fn(async () => ({ allowed: true })),
  })
);
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
  getSyncGenerationState: vi.fn(async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 1,
    lastPeerGeneration: 0,
    lastPeerContact: null,
  })),
}));
vi.mock("../../utils/property-relation-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncRelationToPropertyOnDelete: vi.fn(async () => undefined),
  syncPropertyToRelations: vi.fn(async () => undefined),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerEntityExecutors } from "../../routers/proposals/executors/entity.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { revertableForRow } from "../../routers/proposals/revert.js";

const USER = randomUUID();
const AGENT = randomUUID();
let client: PGlite;

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
  registerEntityExecutors();
}, 120_000);

async function insertDocument(title: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into documents (id, user_id, workspace_id, title, type) values ($1,$2,null,$3,'markdown')`,
    [id, USER, title]
  );
  return id;
}

async function insertEntity(documentId: string | null): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, workspace_id, type, title, document_id, properties)
     values ($1,$2,null,'decision','Foundation decision',$3,'{}'::jsonb)`,
    [id, USER, documentId]
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

async function proposalRow(id: string) {
  const { rows } = await client.query<{
    id: string;
    status: string;
    target_type: string;
    target_id: string;
    proposal_type: string;
    data: Record<string, any>;
  }>(
    `select id, status, target_type, target_id, proposal_type, data from proposals where id = $1`,
    [id]
  );
  return rows[0]!;
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

/**
 * The agent proposes through the REAL door; the stored patch is the one the
 * gate received, filed as a pending row the way the pending door stores it.
 */
async function agentProposes(patch: Record<string, unknown>): Promise<string> {
  holder.gateCalls = [];
  holder.receiptId = null;
  const out = await (
    await entitiesCaller()
  ).update({ ...(patch as { id: string }), agentUserId: AGENT });
  expect(out).toMatchObject({ status: "proposed" });
  const stored = holder.gateCalls.at(-1)!.data as Record<string, unknown>;
  const id = randomUUID();
  await client.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id)
     values ($1, 'pending', 'update', 'entity', $2, $3::jsonb, $4, $5)`,
    [
      id,
      patch.id,
      JSON.stringify({
        changeType: "update",
        targetType: "entity",
        data: stored,
      }),
      AGENT,
      USER,
    ]
  );
  return id;
}

async function approve(proposalId: string) {
  holder.receiptId = null;
  const row = await proposalRow(proposalId);
  const executor = proposalExecRegistry.resolveExact("entity/update");
  if (!executor) throw new Error("entity/update executor not registered");
  await executor.execute({
    proposal: {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      workspaceId: null,
      agentUserId: AGENT,
      data: row.data,
    },
    payload: row.data,
    userId: USER,
    input: { proposalId },
    deps: {
      emitProposalReviewed: vi.fn(),
      reportProposalOutcome: vi.fn(),
    },
  } as never);
}

async function revert(proposalId: string) {
  const { proposalsRouter } = await import("../../routers/proposals.js");
  return proposalsRouter
    .createCaller({
      db: holder.db,
      authenticated: true,
      userId: USER,
    } as never)
    .revert({ proposalId }) as Promise<{
    success?: boolean;
    skipped?: Array<{ kind: string; reason: string }>;
  }>;
}

const revertable = (row: Awaited<ReturnType<typeof proposalRow>>) =>
  revertableForRow({
    status: row.status,
    targetType: row.target_type,
    targetId: row.target_id,
    proposalType: row.proposal_type,
    data: row.data,
  });

describe("a proposed body REPLACE applies on approval; Undo brings the old body back", () => {
  it("an agent's replacement is always reviewed, and carries replaceBody to approval", async () => {
    const old = await insertDocument("Foundation");
    const entityId = await insertEntity(old);
    const next = await insertDocument("Foundation v2");

    const proposalId = await agentProposes({
      id: entityId,
      documentId: next,
      replaceBody: true,
    });

    const gate = holder.gateCalls.at(-1)!;
    expect(gate.forcePropose).toBe(true);
    expect(gate.data).toMatchObject({ documentId: next, replaceBody: true });
    expect(await bodyOf(entityId)).toBe(old);
    // Predicted undoable BEFORE the decision (the swipe/Undo promise).
    expect(revertable(await proposalRow(proposalId))).toBe(true);
  });

  it("approval attaches it, the record names both bodies, and Undo restores the old one", async () => {
    const old = await insertDocument("Foundation");
    const entityId = await insertEntity(old);
    const next = await insertDocument("Foundation v2");
    const proposalId = await agentProposes({
      id: entityId,
      documentId: next,
      replaceBody: true,
    });

    await approve(proposalId);

    expect(await bodyOf(entityId)).toBe(next);
    const approved = await proposalRow(proposalId);
    expect(approved.status).toBe("approved");
    expect(approved.data.materialized.propertyDiffs[0]).toMatchObject({
      entityId,
      bodyDocumentId: next,
      bodyDocumentIdBefore: old,
    });
    expect(revertable(approved)).toBe(true);

    const result = await revert(proposalId);
    expect(result).toMatchObject({ success: true });
    expect(result.skipped ?? []).toEqual([]);
    expect(await bodyOf(entityId)).toBe(old);
  });

  it("a body changed since the approval is KEPT and reported, not overwritten", async () => {
    const old = await insertDocument("Foundation");
    const entityId = await insertEntity(old);
    const next = await insertDocument("Foundation v2");
    const proposalId = await agentProposes({
      id: entityId,
      documentId: next,
      replaceBody: true,
    });
    await approve(proposalId);
    const theirs = await insertDocument("Person's own body");
    await client.query(`update entities set document_id = $1 where id = $2`, [
      theirs,
      entityId,
    ]);

    const result = await revert(proposalId);

    expect((result.skipped ?? []).map((s) => [s.kind, s.reason])).toEqual([
      ["entity_body", "edited_since"],
    ]);
    expect(await bodyOf(entityId)).toBe(theirs);
  });

  it("a previous body deleted since is never re-linked", async () => {
    const old = await insertDocument("Foundation");
    const entityId = await insertEntity(old);
    const next = await insertDocument("Foundation v2");
    const proposalId = await agentProposes({
      id: entityId,
      documentId: next,
      replaceBody: true,
    });
    await approve(proposalId);
    await client.query(
      `update documents set deleted_at = now() where id = $1`,
      [old]
    );

    const result = await revert(proposalId);

    expect((result.skipped ?? []).map((s) => [s.kind, s.reason])).toEqual([
      ["entity_body", "not_found"],
    ]);
    expect(await bodyOf(entityId)).toBe(next);
  });
});

describe("a proposed ATTACH onto an entity with no body", () => {
  it("applies on approval (it used to change nothing) and Undo takes it off", async () => {
    const entityId = await insertEntity(null);
    const doc = await insertDocument("Orphaned notes");
    const proposalId = await agentProposes({ id: entityId, documentId: doc });
    // A plain attach is not force-proposed: the ordinary lane decides it.
    expect(holder.gateCalls.at(-1)!.forcePropose).toBe(false);

    await approve(proposalId);
    expect(await bodyOf(entityId)).toBe(doc);

    await revert(proposalId);
    expect(await bodyOf(entityId)).toBeNull();
  });
});

describe("an AUTO-APPROVED attach is undoable from its receipt", () => {
  it("the write stamps the receipt with the body change; revert restores", async () => {
    const old = await insertDocument("Foundation");
    const entityId = await insertEntity(old);
    const next = await insertDocument("Foundation v2");
    const receiptId = randomUUID();
    await client.query(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id)
       values ($1, 'auto_approved', 'entity.update', 'entity', $2, $3::jsonb, $4, $4)`,
      [
        receiptId,
        entityId,
        JSON.stringify({ id: entityId, documentId: next, _autoApprove: {} }),
        USER,
      ]
    );
    holder.receiptId = receiptId;
    await (
      await entitiesCaller()
    ).update({ id: entityId, documentId: next, replaceBody: true });
    holder.receiptId = null;

    expect(await bodyOf(entityId)).toBe(next);
    expect(
      (await proposalRow(receiptId)).data.materialized.propertyDiffs[0]
    ).toMatchObject({ bodyDocumentId: next, bodyDocumentIdBefore: old });

    await revert(receiptId);
    expect(await bodyOf(entityId)).toBe(old);
  });
});

describe("the agent re-attach door: MCP synap_update_entity({ documentId })", () => {
  it("reaches entities.update as the agent, with documentId and replaceBody", async () => {
    const old = await insertDocument("Foundation");
    const entityId = await insertEntity(old);
    const next = await insertDocument("Re-attach me");
    holder.gateCalls = [];
    holder.receiptId = null;
    const { entityHandlers } =
      await import("../../routers/mcp/handlers/entity.js");
    const { createHubProtocolCaller } =
      await import("../../routers/mcp/handlers/shared.js");
    const lensCaller = await createHubProtocolCaller(
      USER,
      ["mcp.read", "mcp.write"],
      AGENT
    );

    const result = await entityHandlers.synap_update_entity!({
      toolName: "synap_update_entity",
      args: { entityId, documentId: next, replaceBody: true },
      userId: USER,
      agentUserId: AGENT,
      apiKeyScopes: ["mcp.read", "mcp.write"],
      lensCaller,
      caller: lensCaller,
    } as never);

    const text = (result.content as Array<{ text?: string }>)
      .map((c) => c.text ?? "")
      .join("");
    expect(JSON.parse(text)).toMatchObject({ status: "proposed" });
    expect(holder.gateCalls).toHaveLength(1);
    expect(holder.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      forcePropose: true,
      data: { documentId: next, replaceBody: true },
    });
    expect(await bodyOf(entityId)).toBe(old);
  });
});
