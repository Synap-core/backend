/**
 * AUTO-APPROVED CREATE UNDO — the `@reversible` lane promises every change it
 * waves through comes with Undo. Live (2026-09-28) every auto-approved CREATE
 * read "Can't be undone": the receipt (`proposalType: "entity.create"`, the
 * gate's DOTTED event key) was never classified as a create, and it carried no
 * record of the row actually written — only the gate's pre-minted `targetId`
 * (receipt 3b0d64cb… named c3d53123…, which does not exist; the entity created
 * was 8059774b…).
 *
 * Driven through the REAL create doors on a real Postgres (PGlite, every table
 * from its drizzle definition): `entities.create`, `relations.create`, the Hub
 * `documents.createDocument` (external-url branch — no object storage), and
 * `addCreateTimeBlockers` (the agent `link.create` door). Then the list's
 * `revertableForRow` and the REAL `proposals.revert` door.
 *
 * NOT real: the gate. `checkPermissionOrPropose` is replaced by a stand-in that
 * mints the auto-approve receipt FROM THE ARGUMENTS THE DOOR PASSED IT, in the
 * receipt shape the real gate writes (`permission-check.ts`: targetType =
 * subjectType, targetId = `data.id ?? random`, proposalType =
 * `${subjectType}.${action}`, the gate `data` spread flat, status
 * `auto_approved`). If the real gate's receipt shape drifts, this test cannot
 * see it. Governance, audit, side-effects and search indexing are stubbed.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
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
    registerIdentitySignals: async () => undefined,
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
  };
});

/** The receipt the real gate writes on `execute`, minted from the door's own call. */
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn(
      async (opts: {
        userId: string;
        agentUserId?: string;
        workspaceId?: string | null;
        subjectType: string;
        action: string;
        data?: Record<string, unknown>;
      }) => {
        const { proposals } = await import("@synap/database/schema");
        const database = h.db as {
          insert: (t: unknown) => {
            values: (v: unknown) => {
              returning: (r: unknown) => Promise<Array<{ id: string }>>;
            };
          };
        };
        const [receipt] = await database
          .insert(proposals)
          .values({
            workspaceId: opts.workspaceId ?? null,
            targetType: opts.subjectType,
            targetId: String(opts.data?.id ?? randomUUID()),
            proposalType: `${opts.subjectType}.${opts.action}`,
            data: {
              ...(opts.data ?? {}),
              agentUserId: opts.agentUserId,
              _autoApprove: {
                matchedPattern: "@reversible",
                approvedAt: new Date().toISOString(),
                approvedBy: "system:auto_approve",
              },
            },
            status: "auto_approved",
            createdBy: opts.agentUserId ?? opts.userId,
            subjectUserId: opts.userId,
          })
          .returning({ id: proposals.id });
        return { granted: true, autoApprovedProposalId: receipt!.id };
      }
    ),
  };
});
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
vi.mock("../review-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeCanReviewApproval: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
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
  syncRelationToPropertyOnCreate: vi.fn(async () => undefined),
  syncPropertyToRelations: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { revertableForRow } from "../revert.js";

const USER = randomUUID();
const AGENT = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    else if (c.hasDefault && isArray) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

type ReceiptRow = {
  id: string;
  status: string;
  target_type: string;
  target_id: string;
  proposal_type: string;
  data: Record<string, any>;
};

async function receipt(id: string): Promise<ReceiptRow> {
  return (
    await q<ReceiptRow>(
      `select id, status, target_type, target_id, proposal_type, data from proposals where id = $1`,
      [id]
    )
  ).rows[0]!;
}

/** The receipt the gate minted on the LAST call — read back from the DB. */
async function lastReceipt(): Promise<ReceiptRow> {
  const call = vi.mocked(checkPermissionOrPropose).mock.results.at(-1);
  const granted = (await call!.value) as { autoApprovedProposalId: string };
  return receipt(granted.autoApprovedProposalId);
}

/** Exactly the call `proposals.list` makes per row. */
function listRevertable(row: ReceiptRow): boolean {
  return revertableForRow({
    status: row.status,
    targetType: row.target_type,
    targetId: row.target_id,
    proposalType: row.proposal_type,
    data: row.data,
  });
}

async function revert(proposalId: string) {
  const { proposalsRouter } = await import("../../proposals.js");
  return proposalsRouter
    .createCaller({
      db: h.db,
      authenticated: true,
      userId: USER,
    } as Parameters<typeof proposalsRouter.createCaller>[0])
    .revert({ proposalId });
}

async function createEntity(
  title: string,
  agentUserId?: string,
  forceCreate = false
) {
  const { entitiesRouter } = await import("../../entities.js");
  return (await entitiesRouter
    .createCaller({
      db: h.db,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never)
    .create({
      profileSlug: "person",
      title,
      source: "ai",
      ...(agentUserId ? { agentUserId } : {}),
      // Past the pre-gate same-name check, so the retry reaches the
      // post-gate retry dedup (the branch that holds a receipt).
      ...(forceCreate ? { forceCreate } : {}),
    } as never)) as { id: string; ackState?: string };
}

async function entityDeletedAt(id: string): Promise<unknown> {
  const { rows } = await q<{ deleted_at: unknown }>(
    `select deleted_at from entities where id = $1`,
    [id]
  );
  return rows[0]?.deleted_at;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // The unique edge the link doors' ON CONFLICT targets (the DDL helper
  // creates columns only).
  await h.client!.exec(
    `create unique index links_edge_unique on links (from_type, from_id, to_type, to_id, link_type)`
  );

  await q(`insert into users (id, email) values ($1, 'u@x.test')`, [USER]);
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, applicable_kinds)
     values (gen_random_uuid(),'person','Person','kind','system','pod',null,true,'{}'::jsonb,null)`
  );
}, 120_000);

beforeEach(() => {
  vi.mocked(checkPermissionOrPropose).mockClear();
});

describe("an AUTO-APPROVED entity create is undoable", () => {
  it("the receipt names the REAL created id; revert retires THAT row", async () => {
    const created = await createEntity("Ada Undo");
    const row = await lastReceipt();

    expect(row.proposal_type).toBe("entity.create");
    expect(row.status).toBe("auto_approved");
    // The record revert reads is the row the door wrote — whatever the gate
    // guessed as `targetId`.
    expect(row.data.materialized?.entityIds).toEqual([created.id]);
    expect(listRevertable(row)).toBe(true);

    const result = await revert(row.id);

    expect(result).toMatchObject({ success: true });
    expect(await entityDeletedAt(created.id)).not.toBeNull();
    expect((await receipt(row.id)).status).toBe("reverted");
  });

  it("a retried create the door DEDUPED stamps 'created nothing' — its Undo can never retire the first write's row", async () => {
    const first = await createEntity("Bo Retry", AGENT, true);
    const firstReceipt = await lastReceipt();
    const second = await createEntity("Bo Retry", AGENT, true);
    const secondReceipt = await lastReceipt();

    expect(second.ackState).toBe("duplicate-ignored");
    expect(second.id).toBe(first.id);
    expect(secondReceipt.id).not.toBe(firstReceipt.id);
    expect(secondReceipt.data.materialized).toBeDefined();
    expect(secondReceipt.data.materialized.entityIds ?? []).toEqual([]);
    expect(listRevertable(secondReceipt)).toBe(false);
    await expect(revert(secondReceipt.id)).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    expect(await entityDeletedAt(first.id)).toBeNull();
    // The first write keeps ITS undo.
    expect(listRevertable(firstReceipt)).toBe(true);
  });
});

describe("an AUTO-APPROVED relation create is undoable", () => {
  it("stamps the created edge; revert removes it", async () => {
    const a = await createEntity("Rel Source");
    const b = await createEntity("Rel Target");
    const { relationsRouter } = await import("../../relations.js");
    const created = (await relationsRouter
      .createCaller({
        db: h.db,
        authenticated: true,
        userId: USER,
        workspaceId: null,
      } as never)
      .create({
        sourceEntityId: a.id,
        targetEntityId: b.id,
        type: "same_subject",
      } as never)) as { id: string; status: string };
    expect(created.status).toBe("created");
    const row = await lastReceipt();

    expect(row.proposal_type).toBe("relation.create");
    expect(row.data.materialized?.relationIds).toEqual([created.id]);
    expect(listRevertable(row)).toBe(true);

    expect(await revert(row.id)).toMatchObject({ success: true });
    // Relations are hard-deleted by the undo engine.
    const { rows } = await q(`select id from relations where id = $1`, [
      created.id,
    ]);
    expect(rows).toEqual([]);
  });
});

describe("an AUTO-APPROVED document create is undoable", () => {
  it("stamps the created document; revert deletes it", async () => {
    const { documentsRouter } = await import("../../hub-protocol/documents.js");
    const created = (await documentsRouter
      .createCaller({
        db: h.db,
        authenticated: true,
        userId: USER,
        scopes: ["hub-protocol.write"],
      } as never)
      .createDocument({
        userId: USER,
        title: "External brief",
        url: "https://example.test/brief",
        agentUserId: AGENT,
      })) as { id: string; status: string };
    expect(created.status).toBe("created");
    const row = await lastReceipt();

    expect(row.proposal_type).toBe("document.create");
    expect(row.data.materialized?.documentIds).toEqual([created.id]);
    expect(listRevertable(row)).toBe(true);

    expect(await revert(row.id)).toMatchObject({ success: true });
    const { rows } = await q(`select id from documents where id = $1`, [
      created.id,
    ]);
    expect(rows).toEqual([]);
  });
});

describe("an AUTO-APPROVED link create is undoable", () => {
  it("stamps the created edge; revert removes it; an existing edge stamps nothing", async () => {
    const blocked = randomUUID();
    const blocker = randomUUID();
    for (const id of [blocked, blocker]) {
      await q(`insert into focus_sessions (id, user_id) values ($1, $2)`, [
        id,
        USER,
      ]);
    }
    const { addCreateTimeBlockers } =
      await import("../../../services/focus-sessions/session-blocked-by.js");
    const [report] = await addCreateTimeBlockers({
      sessionId: blocked,
      blockerSessionIds: [blocker],
      userId: USER,
      agentUserId: AGENT,
    });
    expect(report, JSON.stringify(report)).toMatchObject({
      status: "linked",
      inserted: 1,
    });
    const row = await lastReceipt();
    const { rows: edges } = await q<{ id: string }>(
      `select id from links where from_id = $1 and to_id = $2 and link_type = 'blocked_by'`,
      [blocked, blocker]
    );
    expect(edges).toHaveLength(1);

    expect(row.proposal_type).toBe("link.create");
    expect(row.data.materialized?.linkIds).toEqual([edges[0]!.id]);
    expect(listRevertable(row)).toBe(true);

    // The same edge again: the door inserted nothing, so its receipt owns nothing.
    await addCreateTimeBlockers({
      sessionId: blocked,
      blockerSessionIds: [blocker],
      userId: USER,
      agentUserId: AGENT,
    });
    const again = await lastReceipt();
    expect(again.data.materialized?.linkIds ?? []).toEqual([]);
    expect(listRevertable(again)).toBe(false);

    expect(await revert(row.id)).toMatchObject({ success: true });
    const { rows: after } = await q(`select id from links where id = $1`, [
      edges[0]!.id,
    ]);
    expect(after).toEqual([]);
  });
});
