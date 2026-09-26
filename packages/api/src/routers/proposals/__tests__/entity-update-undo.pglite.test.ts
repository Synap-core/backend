/**
 * ENTITY UPDATE UNDO — an applied entity update is revertable from the record
 * its write stamped at APPLY time, driven through the real doors on a real
 * Postgres (PGlite).
 *
 *  - the approve half: the real `entity/update` executor → the real
 *    `entities.update` procedure → `stampEntityUpdate` on the proposal row;
 *  - the auto-approve half: `entities.update` with the gate answering
 *    `granted` + a receipt id (the gate itself is mocked — it has its own
 *    suites) → the stamp lands on that receipt;
 *  - the undo: the real `proposals.revert` door → `planProposalRevert` →
 *    `revertProposalCreations` → `safeRevert` compare-and-restore.
 *
 * Tables are created FROM THEIR DRIZZLE DEFINITIONS (same helper shape as
 * `cancel-and-item-revert.pglite.test.ts`).
 *
 * NOT covered (NEEDS-DOGFOOD): the client surfaces reading `revertable` and
 * `skipped` (relay card Undo, browser history), and a profile-validated entity
 * (these rows carry no profile, so validation/normalization is not exercised).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    registerIdentitySignals: async () => undefined,
    getDb: async () => holder.db,
    // Hookless: the realtime fan-out is not under test.
    eventRepository: { append: async () => undefined },
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
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));
vi.mock("../review-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeCanReviewApproval: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
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
vi.mock("../../../utils/property-relation-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncRelationToPropertyOnDelete: vi.fn(async () => undefined),
  syncPropertyToRelations: vi.fn(async () => undefined),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  relations,
  entityFacets,
  links,
  proposals,
  workspaces,
  workspaceMembers,
  projectMembers,
  podMembers,
  users,
  type db as DatabaseHandle,
} from "@synap/database";
import { isSwipeSafe } from "@synap-core/types/proposals/intent";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { revertableForRow } from "../revert.js";
import { registerEntityExecutors } from "../executors/entity.js";
import { proposalExecRegistry } from "../execution-registry.js";

const USER = "user-1";
type Database = typeof DatabaseHandle;

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

async function freshDb() {
  const client = new PGlite();
  for (const table of [
    entities,
    relations,
    entityFacets,
    links,
    proposals,
    workspaces,
    workspaceMembers,
    projectMembers,
    podMembers,
    users,
  ]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  // A KNOWN principal (Sites W2 S2): an id with no `users` row is an unknown
  // principal and reads no pod-level row — `podReaderWhere`.
  await client.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  const database = drizzle(client, {
    schema: { entities, proposals, workspaces, workspaceMembers },
  }) as unknown as Database;
  holder.db = database;
  return { client, database };
}

async function insertEntity(client: PGlite): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, title, preview, properties)
     values ($1, $2, 'note', 'Old title', 'Old description', $3::jsonb)`,
    [id, USER, JSON.stringify({ stage: "lead", owner: "ann", gone: "x" })]
  );
  return id;
}

async function entityRow(client: PGlite, id: string) {
  return (
    await client.query<{
      title: string | null;
      preview: string | null;
      properties: Record<string, unknown>;
    }>(`select title, preview, properties from entities where id = $1`, [id])
  ).rows[0]!;
}

async function proposalRow(client: PGlite, id: string) {
  return (
    await client.query<{
      id: string;
      status: string;
      target_type: string;
      target_id: string;
      proposal_type: string;
      data: Record<string, any>;
    }>(
      `select id, status, target_type, target_id, proposal_type, data from proposals where id = $1`,
      [id]
    )
  ).rows[0]!;
}

/** The agent's edit, as the pending door stores it (request-shaped). */
const EDIT = {
  title: "New title",
  description: "New description",
  properties: { stage: "client", added: 1 },
  deleteProperties: ["gone"],
};

/** A PENDING entity update exactly as `createPendingProposalRow` writes it. */
async function insertPendingUpdate(
  client: PGlite,
  entityId: string
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id)
     values ($1, 'pending', 'update', 'entity', $2, $3::jsonb, 'agent-1', $4)`,
    [
      id,
      entityId,
      JSON.stringify({
        changeType: "update",
        targetType: "entity",
        data: { id: entityId, ...EDIT },
      }),
      USER,
    ]
  );
  return id;
}

async function approveThroughExecutor(client: PGlite, proposalId: string) {
  const row = await proposalRow(client, proposalId);
  const executor = proposalExecRegistry.resolveExact("entity/update");
  if (!executor) throw new Error("entity/update executor not registered");
  await executor.execute({
    proposal: {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      workspaceId: null,
      agentUserId: "agent-1",
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

/** An auto-approved write: the gate grants and names its receipt. */
async function autoApprovedUpdate(
  client: PGlite,
  database: Database,
  entityId: string
): Promise<string> {
  const receiptId = randomUUID();
  await client.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id)
     values ($1, 'auto_approved', 'entity.update', 'entity', $2, $3::jsonb, 'agent-1', $4)`,
    [
      receiptId,
      entityId,
      JSON.stringify({ id: entityId, ...EDIT, _autoApprove: {} }),
      USER,
    ]
  );
  vi.mocked(checkPermissionOrPropose).mockResolvedValueOnce({
    granted: true,
    autoApprovedProposalId: receiptId,
  } as never);
  const { entitiesRouter } = await import("../../entities.js");
  const caller = entitiesRouter.createCaller({
    db: database,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);
  await caller.update({ id: entityId, ...EDIT, source: "ai" });
  return receiptId;
}

async function revertCaller(database: Database) {
  const { proposalsRouter } = await import("../../proposals.js");
  return proposalsRouter.createCaller({
    db: database,
    authenticated: true,
    userId: USER,
  } as Parameters<typeof proposalsRouter.createCaller>[0]);
}

const ORIGINAL = {
  title: "Old title",
  preview: "Old description",
  properties: { stage: "lead", owner: "ann", gone: "x" },
};

registerEntityExecutors();

beforeEach(() => {
  vi.mocked(checkPermissionOrPropose).mockClear();
});

describe("an APPROVED entity update is undoable from its apply-time stamp", () => {
  it("a pending update is predicted revertable, and swipe-safe from the list's wire shape", async () => {
    const { client } = await freshDb();
    const entityId = await insertEntity(client);
    const row = await proposalRow(
      client,
      await insertPendingUpdate(client, entityId)
    );
    // The exact call `proposals.list` makes for each row.
    const revertable = revertableForRow({
      status: row.status,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      data: row.data,
    });
    expect(revertable).toBe(true);
    // `kind: "update"` is the presentation kind of an entity update; the pending
    // door stores no governanceReason for a routine update.
    expect(
      isSwipeSafe({ kind: "update", changeType: "update", revertable })
    ).toBe(true);
  });

  it("approve stamps before/after; revert restores title, description, changed, added and deleted keys", async () => {
    const { client, database } = await freshDb();
    const entityId = await insertEntity(client);
    const proposalId = await insertPendingUpdate(client, entityId);

    await approveThroughExecutor(client, proposalId);

    expect(await entityRow(client, entityId)).toEqual({
      title: "New title",
      preview: "New description",
      properties: { stage: "client", owner: "ann", added: 1 },
    });
    const approved = await proposalRow(client, proposalId);
    expect(approved.status).toBe("approved");
    const diff = approved.data.materialized.propertyDiffs[0];
    expect(diff).toMatchObject({
      entityId,
      before: { stage: "lead", gone: "x" },
      after: { stage: "client", added: 1 },
      absentBefore: ["added"],
      absentAfter: ["gone"],
      fields: {
        before: { title: "Old title", preview: "Old description" },
        after: { title: "New title", preview: "New description" },
      },
    });
    expect(
      revertableForRow({
        status: approved.status,
        targetType: approved.target_type,
        targetId: approved.target_id,
        proposalType: approved.proposal_type,
        data: approved.data,
      })
    ).toBe(true);

    const result = await (await revertCaller(database)).revert({ proposalId });

    expect(result).toMatchObject({ success: true });
    expect((result as { skipped?: unknown[] }).skipped ?? []).toEqual([]);
    expect(await entityRow(client, entityId)).toEqual(ORIGINAL);
    expect((await proposalRow(client, proposalId)).status).toBe("reverted");
  });

  it("a key the user edited after the write is KEPT and reported; every other key is restored", async () => {
    const { client, database } = await freshDb();
    const entityId = await insertEntity(client);
    const proposalId = await insertPendingUpdate(client, entityId);
    await approveThroughExecutor(client, proposalId);

    // The user changes `stage` and the title after the agent's write.
    await client.query(
      `update entities set title = 'User title', properties = properties || '{"stage":"won"}'::jsonb where id = $1`,
      [entityId]
    );

    const result = (await (
      await revertCaller(database)
    ).revert({
      proposalId,
    })) as { skipped?: Array<{ key?: string; reason: string }> };

    expect((result.skipped ?? []).map((s) => [s.key, s.reason]).sort()).toEqual(
      [
        ["stage", "edited_since"],
        ["title", "edited_since"],
      ]
    );
    expect(await entityRow(client, entityId)).toEqual({
      title: "User title",
      preview: "Old description",
      properties: { stage: "won", owner: "ann", gone: "x" },
    });
  });

  it("a LEGACY approved update (no stamp) stays unsupported and the revert fails loud", async () => {
    const { client, database } = await freshDb();
    const entityId = await insertEntity(client);
    const proposalId = await insertPendingUpdate(client, entityId);
    await client.query(
      `update proposals set status = 'approved' where id = $1`,
      [proposalId]
    );
    const row = await proposalRow(client, proposalId);
    expect(
      revertableForRow({
        status: row.status,
        targetType: row.target_type,
        targetId: row.target_id,
        proposalType: row.proposal_type,
        data: row.data,
      })
    ).toBe(false);
    await expect(
      (await revertCaller(database)).revert({ proposalId })
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
});

describe("an update undo cannot fully restore is never predicted revertable", () => {
  it.each(["profileSlug", "global", "documentId", "sourceFile"] as const)(
    "a pending update carrying %s is not revertable, so not swipe-safe",
    async (key) => {
      const { client } = await freshDb();
      const entityId = await insertEntity(client);
      const id = randomUUID();
      const value =
        key === "global"
          ? true
          : key === "sourceFile"
            ? { storageKey: "k" }
            : key === "documentId"
              ? randomUUID()
              : "invoice";
      await client.query(
        `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id)
         values ($1, 'pending', 'update', 'entity', $2, $3::jsonb, 'agent-1', $4)`,
        [
          id,
          entityId,
          JSON.stringify({
            changeType: "update",
            targetType: "entity",
            data: { id: entityId, ...EDIT, [key]: value },
          }),
          USER,
        ]
      );
      const row = await proposalRow(client, id);
      const input = {
        status: row.status,
        targetType: row.target_type,
        targetId: row.target_id,
        proposalType: row.proposal_type,
        data: row.data,
      };
      expect(revertableForRow(input)).toBe(false);
      expect(
        isSwipeSafe({
          kind: "update",
          changeType: "update",
          revertable: revertableForRow(input),
        })
      ).toBe(false);
      // Once applied with a stamp, the planner refuses it the same way —
      // the prediction and the outcome never disagree.
      expect(
        revertableForRow({
          ...input,
          status: "approved",
          data: {
            ...row.data,
            materialized: {
              propertyDiffs: [
                {
                  entityId,
                  before: { stage: "lead" },
                  after: { stage: "client" },
                  absentBefore: [],
                },
              ],
            },
          },
        })
      ).toBe(false);
    }
  );
});

describe("undo → reopen → re-approve → undo restores what the person kept", () => {
  it.each([
    ["approved→reopen (partial undo straight back to review)", true],
    ["reverted→reopen (partial undo, then re-propose)", false],
  ] as const)("%s", async (_label, reopenOnUndo) => {
    const { client, database } = await freshDb();
    const entityId = await insertEntity(client);
    const proposalId = await insertPendingUpdate(client, entityId);
    await approveThroughExecutor(client, proposalId);

    // The person keeps their own `stage` and title after the agent's write.
    await client.query(
      `update entities set title = 'User title', properties = properties || '{"stage":"won"}'::jsonb where id = $1`,
      [entityId]
    );
    const caller = await revertCaller(database);
    if (reopenOnUndo) {
      await caller.revert({ proposalId, reopen: true });
    } else {
      await caller.revert({ proposalId });
      expect((await proposalRow(client, proposalId)).status).toBe("reverted");
      await caller.revert({ proposalId, reopen: true });
    }
    expect((await proposalRow(client, proposalId)).status).toBe("pending");

    // Re-approve: the write lands again over the person's values.
    await approveThroughExecutor(client, proposalId);
    expect((await entityRow(client, entityId)).title).toBe("New title");

    // Undo again: the values the person had when it was RE-approved come back
    // — never the original ones from before the first approval.
    await caller.revert({ proposalId });
    const after = await entityRow(client, entityId);
    expect(after.title).toBe("User title");
    expect(after.properties.stage).toBe("won");
  });
});

describe("an AUTO-APPROVED entity update is undoable from its receipt", () => {
  it("the write stamps its receipt; revert restores the before values", async () => {
    const { client, database } = await freshDb();
    const entityId = await insertEntity(client);

    const receiptId = await autoApprovedUpdate(client, database, entityId);

    const receipt = await proposalRow(client, receiptId);
    expect(receipt.data.materialized.propertyDiffs).toHaveLength(1);
    expect(
      revertableForRow({
        status: receipt.status,
        targetType: receipt.target_type,
        targetId: receipt.target_id,
        proposalType: receipt.proposal_type,
        data: receipt.data,
      })
    ).toBe(true);

    const result = await (
      await revertCaller(database)
    ).revert({
      proposalId: receiptId,
    });
    expect(result).toMatchObject({ success: true });
    expect(await entityRow(client, entityId)).toEqual(ORIGINAL);
  });
});
