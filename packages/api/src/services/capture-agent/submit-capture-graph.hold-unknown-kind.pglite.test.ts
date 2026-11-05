/**
 * A4 (founder decision D2): an item whose kind is not available where it
 * lands is HELD for review; its siblings still file.
 *
 * The e8fc00d6 shape, reduced: an agent captures into Foundation a pain point
 * (a Foundation kind) and a trend (a kind only Ecosystem has), linked. Before
 * A4 the graph auto-applied whole and stopped at the trend. Now:
 *  - the pain point lands under the auto-apply receipt (rules out refusing
 *    the whole capture);
 *  - the trend is NOT created anywhere (rules out applying it, and filing it
 *    as some other kind) — it waits in its own pending proposal, linked to the
 *    receipt, whose relation names the pain point's REAL id (rules out a
 *    duplicate pain point when it is approved);
 *  - the reply names the held item, Ecosystem as where the kind exists, and
 *    the fix; Hidden, a space holding `trend` that the user cannot read, is
 *    never named.
 * And the revision check refuses a revision that swaps in another unknown
 * kind, while a revision to a resolvable kind passes (the control).
 *
 * Driven through the REAL `submitCaptureGraph`, the REAL materializer and
 * `entities.create` and the REAL agent pending cap, on PGlite with every
 * table. Stubbed, as in the other PGlite suites: the governance verdict
 * (execute), audit, the read-only guard, side effects, the agent focus, and
 * the pending writer's insert (it reads a client PGlite cannot replace).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: vi
    .fn()
    .mockResolvedValue({ decision: "execute" }),
}));
vi.mock("../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-identity-service.js")>()),
  getAgentFocusProjectId: vi.fn(async () => null),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/permission-check.js")>()),
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
  isJoinGate: vi.fn(() => false),
}));
// The pending writer's SSOT insert (`insertPendingProposal`) reads the
// database package's own client, which the PGlite mock above cannot reach;
// this stand-in writes the same row through the mocked `db`.
vi.mock("../../utils/event-backed-proposal.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../utils/event-backed-proposal.js")
    >();
  return {
    ...actual,
    createEventBackedProposal: vi.fn(
      async (input: {
        userId: string;
        workspaceId?: string | null;
        targetType: string;
        targetId: string;
        proposalType: string;
        agentUserId?: string;
        data: Record<string, unknown>;
      }) => {
        const id = randomUUID();
        await h.client!.query(
          `insert into proposals (id, created_by, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, data)
           values ($1,$2,'pending',$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            id,
            input.userId,
            input.proposalType,
            input.targetType,
            input.targetId,
            input.workspaceId ?? null,
            input.agentUserId ?? null,
            JSON.stringify(input.data),
          ]
        );
        return { proposal: { id }, requestedEvent: null, correlationId: id };
      }
    ),
  };
});
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import {
  submitCaptureGraph,
  validateCompositeOperations,
} from "./submit-capture-graph.js";

const USER = randomUUID();
const OTHER = randomUUID();
const AGENT = randomUUID();
const FOUNDATION = randomUUID();
const ECOSYSTEM = randomUUID();
const HIDDEN = randomUUID();

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
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
/** `create unique index` for each unique index made only of plain columns. */
function uniqueIndexDdl(table: PgTable): string[] {
  const cfg = getTableConfig(table);
  const out: string[] = [];
  for (const idx of cfg.indexes) {
    const c = idx.config as {
      name?: string;
      unique?: boolean;
      where?: unknown;
      columns: Array<{ name?: unknown }>;
    };
    if (!c.unique || c.where || !c.name) continue;
    const names = c.columns.map((col) => col.name);
    if (!names.every((n): n is string => typeof n === "string")) continue;
    out.push(
      `create unique index if not exists "${c.name}" on "${cfg.name}" (${names
        .map((n) => `"${n}"`)
        .join(", ")});`
    );
  }
  return out;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const PAIN = "Agent memory keeps contradictory old facts";
const TREND = "Agent-memory users now demand deletion";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  for (const t of byName.values()) {
    for (const sql of uniqueIndexDdl(t)) await h.client!.exec(sql);
  }

  await q(
    `insert into users (id, email, user_type) values ($1,'me@x.test','human'),($2,'them@x.test','human'),($3,'agent@x.test','agent')`,
    [USER, OTHER, AGENT]
  );
  for (const [ws, name, owner] of [
    [FOUNDATION, "Foundation", USER],
    [ECOSYSTEM, "Ecosystem", USER],
    [HIDDEN, "Hidden", OTHER],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,$2,$3,'team','{}'::jsonb)`,
      [ws, name, owner]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, owner]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, origin)
     values (gen_random_uuid(),'pain-point','Pain point','kind','workspace','workspace',$1,true,'{}'::jsonb,'authored'),
            (gen_random_uuid(),'trend','Trend','kind','workspace','workspace',$2,true,'{}'::jsonb,'authored'),
            (gen_random_uuid(),'trend','Trend','kind','workspace','workspace',$3,true,'{}'::jsonb,'authored')`,
    [FOUNDATION, ECOSYSTEM, HIDDEN]
  );
  await q(
    `insert into relation_defs (id, slug, display_name, user_id) values (gen_random_uuid(),'relates_to','Relates to',$1)`,
    [USER]
  );
}, 120_000);

describe("an item whose kind is not available where it lands is held", () => {
  it("files the sibling, holds the item in its own proposal, and says so", async () => {
    const result = await submitCaptureGraph({
      userId: USER,
      agentUserId: AGENT,
      workspaceId: FOUNDATION,
      source: "agent",
      entities: [
        { ref: "p1", profileSlug: "pain-point", title: PAIN },
        { ref: "t", profileSlug: "trend", title: TREND },
      ],
      relations: [{ sourceRef: "p1", targetRef: "t", type: "relates_to" }],
    } as never);

    // The sibling landed, under the auto-apply receipt.
    expect(result.applied).toBe(true);
    expect(result.entityCount).toBe(1);
    const receiptId = result.proposalId!;
    const landed = (
      await q(
        `select id, title, workspace_id from entities where source_proposal_id = $1`,
        [receiptId]
      )
    ).rows as Array<{ id: string; title: string; workspace_id: string }>;
    expect(landed.map((e) => e.title)).toEqual([PAIN]);
    expect(landed[0]!.workspace_id).toBe(FOUNDATION);
    // The held item was created nowhere.
    const trends = (
      await q(`select id from entities where title = $1`, [TREND])
    ).rows;
    expect(trends).toEqual([]);

    // The receipt is a clean apply of what it filed, and names the hold.
    const receipt = (
      await q(`select status, data from proposals where id = $1`, [receiptId])
    ).rows[0] as { status: string; data: Record<string, any> };
    expect(receipt.status).toBe("auto_approved");
    expect(
      receipt.data.operations.map(
        (o: { ref?: string; op: string }) => o.ref ?? o.op
      )
    ).toEqual(["p1"]);

    // The reply names the held item, where the kind exists, and the fix.
    expect(result.held).toHaveLength(1);
    const held = result.held![0]!;
    expect(held).toMatchObject({
      ref: "t",
      label: TREND,
      profileSlug: "trend",
      workspaceId: FOUNDATION,
      kindMissing: {
        profileSlug: "trend",
        kindName: "Trend",
        workspaceId: FOUNDATION,
        workspaceName: "Foundation",
        foundIn: [{ workspaceId: ECOSYSTEM, name: "Ecosystem" }],
      },
      suggestions: [
        {
          action: "file_in_workspace",
          workspaceId: ECOSYSTEM,
          name: "Ecosystem",
        },
      ],
    });
    expect(held.message).toContain(`"${TREND}" is held for review`);
    expect(held.message).toContain("It exists in Ecosystem.");
    expect(held.notFiled).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Hidden");
    expect(receipt.data.heldItems).toEqual([
      expect.objectContaining({ ref: "t", proposalId: held.proposalId }),
    ]);

    // It waits in its own pending proposal, linked to the receipt, and its
    // relation names the pain point that already landed.
    const pending = (
      await q(
        `select status, proposal_type, agent_user_id, data from proposals where id = $1`,
        [held.proposalId]
      )
    ).rows[0] as {
      status: string;
      proposal_type: string;
      agent_user_id: string;
      data: Record<string, any>;
    };
    expect(pending.status).toBe("pending");
    expect(pending.proposal_type).toBe("import.graph");
    expect(pending.agent_user_id).toBe(AGENT);
    expect(pending.data.heldFromProposalId).toBe(receiptId);
    expect(pending.data.operations).toEqual([
      expect.objectContaining({
        op: "create_entity",
        ref: "t",
        profileSlug: "trend",
      }),
      {
        op: "create_relation",
        type: "relates_to",
        sourceRef: landed[0]!.id,
        targetRef: "t",
      },
    ]);
  });

  it("refuses a revision that swaps in another unknown kind", async () => {
    const revised = await validateCompositeOperations(db, {
      userId: USER,
      workspaceId: FOUNDATION,
      operations: [
        { op: "create_entity", ref: "t", profileSlug: "signal", title: TREND },
      ] as never,
    });
    expect(revised.problems).toEqual([
      `"${TREND}" (signal): The kind "signal" isn't available in Foundation.`,
    ]);
    // Ecosystem's kind is not available in Foundation either.
    const stillTrend = await validateCompositeOperations(db, {
      userId: USER,
      workspaceId: FOUNDATION,
      operations: [
        { op: "create_entity", ref: "t", profileSlug: "trend", title: TREND },
      ] as never,
    });
    expect(stillTrend.problems).toEqual([
      `"${TREND}" (trend): The kind "Trend" isn't available in Foundation. It exists in Ecosystem.`,
    ]);
    // CONTROL: the fix the reply suggests passes — the item pinned to
    // Ecosystem, where the kind lives.
    const fixed = await validateCompositeOperations(db, {
      userId: USER,
      workspaceId: FOUNDATION,
      operations: [
        {
          op: "create_entity",
          ref: "t",
          profileSlug: "trend",
          title: TREND,
          targetWorkspaceId: ECOSYSTEM,
        },
      ] as never,
    });
    expect(fixed.problems).toEqual([]);
  });
});
