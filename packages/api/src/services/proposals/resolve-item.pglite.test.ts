/**
 * Resolving the waiting item of a graph that stopped part-way, end to end.
 *
 * Live 2026-10-22 (proposal e8fc00d6): a capture graph filed four records,
 * stopped on the fifth (kind `trend`, which exists only in Ecosystem, not in
 * Foundation where it was filed), and never ran the three links from it.
 * Approving again could have filed the four records twice (a second approval
 * run is keyed differently). `proposals.resolveItem` files only the waiting
 * item and the links that need it.
 *
 * Driven through the REAL doors on PGlite with every table: the stopped run
 * is made by the auto-apply materializer (`materializeAgentGraphUnderReceipt`),
 * then `proposals.resolveOptions` / `proposals.resolveItem` are called through
 * the real router (visibility, the approve ladder, the agent floor), which
 * resume through the real composite materializer, `entities.create` and
 * `relations.create`. Stubbed: governance (allow), audit, the read-only
 * guard, side effects.
 *
 * Rows that rule out a wrong resolution:
 *  - after `file_in_workspace`, each landed title still exists ONCE (rules
 *    out re-running the graph), the trend exists once, in Ecosystem (rules
 *    out filing it in place), and its three links point at the ORIGINAL
 *    landed ids (rules out links to fresh copies);
 *  - `skip` files nothing and leaves out the three links that need the item;
 *  - a person outside the space, and an agent caller, are refused and the
 *    receipt is unchanged.
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
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/permission-check.js")>()),
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
  isJoinGate: vi.fn(() => false),
}));
vi.mock("../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(),
}));
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => {},
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {},
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { materializeAgentGraphUnderReceipt } from "../capture-agent/submit-capture-graph.js";
import { proposalsRouter } from "../../routers/proposals.js";

const USER = randomUUID();
const OTHER = randomUUID();
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

const PAINS = [
  "Agent memory keeps contradictory old facts",
  "Deleting AI memory leaves the raw messages",
  "No portable standard to move AI memory",
  "Memory exports are unreadable",
];
const TREND = "Agent-memory users now demand deletion";

function graph(tag: string) {
  return [
    ...PAINS.map((title, i) => ({
      op: "create_entity",
      ref: `p${i + 1}`,
      profileSlug: "pain-point",
      title: `${title} ${tag}`,
      targetWorkspaceId: FOUNDATION,
    })),
    {
      op: "create_entity",
      ref: "t",
      profileSlug: "trend",
      title: `${TREND} ${tag}`,
      properties: { description: "Users ask for real deletion" },
    },
    ...[1, 2, 3].map((n) => ({
      op: "create_relation",
      type: "relates_to",
      sourceRef: "t",
      targetRef: `p${n}`,
    })),
  ];
}

/** A receipt whose graph stopped on its 5th op (the trend). */
async function stoppedReceipt(tag: string): Promise<string> {
  const id = randomUUID();
  const operations = graph(tag);
  const data = {
    operations,
    graphSource: "capture",
    source: "agent",
    materialized: { entityIds: [] as string[] },
  };
  await q(
    `insert into proposals (id, created_by, status, proposal_type, target_type, target_id, workspace_id, data)
     values ($1,$2,'auto_approved','capture.graph','entity',$3,$4,$5::jsonb)`,
    [id, USER, randomUUID(), FOUNDATION, JSON.stringify(data)]
  );
  await expect(
    materializeAgentGraphUnderReceipt(
      {
        db,
        authenticated: true,
        userId: USER,
        workspaceId: FOUNDATION,
        workspaceRole: "owner",
        sessionId: null,
        governanceProposalId: id,
      },
      {
        receipt: { id, data },
        operations: operations as never,
        agentUserId: null,
        source: "agent",
        idempotencyKey: `resolve-test-${tag}`,
      }
    )
  ).rejects.toThrow("Profile not found: trend");
  return id;
}

const caller = (userId: string, extra: Record<string, unknown> = {}) =>
  proposalsRouter.createCaller({
    db,
    authenticated: true,
    userId,
    workspaceId: null,
    ...extra,
  } as never);

async function receipt(id: string) {
  const { rows } = await q(
    `select status, reviewed_by, rejection_reason, data from proposals where id = $1`,
    [id]
  );
  return rows[0] as {
    status: string;
    reviewed_by: string | null;
    rejection_reason: string | null;
    data: Record<string, any>;
  };
}

async function entitiesOf(id: string) {
  return (
    await q(
      `select id, title, workspace_id from entities where source_proposal_id = $1 and deleted_at is null`,
      [id]
    )
  ).rows as Array<{ id: string; title: string; workspace_id: string | null }>;
}

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
    `insert into users (id, email) values ($1,'me@x.test'),($2,'them@x.test')`,
    [USER, OTHER]
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
  // A pod-wide relation type, as the pod seeds them (the type the links use).
  await q(
    `insert into relation_defs (id, slug, display_name, user_id, ui_hints, is_directional)
     values (gen_random_uuid(),'relates_to','Relates to',$1,'{}'::jsonb,false)`,
    [USER]
  );
}, 120_000);

describe("resolving the waiting item of a stopped graph", () => {
  it("offers 'file it in Ecosystem' first, then files only the trend and its links", async () => {
    const id = await stoppedReceipt("A");
    const before = await entitiesOf(id);
    expect(before).toHaveLength(4);

    const options = await caller(USER).resolveOptions({ proposalId: id });
    expect(options.resolvable).toBe(true);
    expect(options.items.map((i) => [i.itemRef, i.state])).toEqual([
      ["t", "failed"],
      ["t->p1:relates_to", "not_run"],
      ["t->p2:relates_to", "not_run"],
      ["t->p3:relates_to", "not_run"],
    ]);
    const trend = options.items[0]!;
    expect(trend.dependents).toEqual([
      "t->p1:relates_to",
      "t->p2:relates_to",
      "t->p3:relates_to",
    ]);
    expect(trend.options[0]).toMatchObject({
      kind: "file_in_workspace",
      action: { type: "file_in_workspace", workspaceId: ECOSYSTEM },
      workspaceName: "Ecosystem",
      recommended: true,
      available: true,
    });
    expect(trend.options.filter((o) => o.recommended)).toHaveLength(1);
    expect(trend.options.map((o) => o.kind)).toEqual(
      expect.arrayContaining(["widen_kind_scope", "create_kind", "skip"])
    );
    expect(trend.options.find((o) => o.kind === "create_kind")).toMatchObject({
      available: false,
      unavailableReason: "not_yet",
      draft: {
        slug: "trend",
        fields: [{ slug: "description", valueType: "string" }],
      },
    });
    // A space the caller cannot read is never named.
    expect(JSON.stringify(options)).not.toContain("Hidden");

    const result = await caller(USER).resolveItem({
      proposalId: id,
      itemRef: "t",
      action: { type: "file_in_workspace", workspaceId: ECOSYSTEM },
    });
    expect(result).toMatchObject({
      complete: true,
      status: "approved",
      outcome: "filed",
      filed: 4,
      waiting: 0,
    });

    const after = await entitiesOf(id);
    // The four landed records were NOT filed again.
    for (const b of before) {
      expect(after.filter((e) => e.title === b.title)).toEqual([b]);
    }
    const trends = after.filter((e) => e.title.startsWith(TREND));
    expect(trends).toHaveLength(1);
    expect(trends[0]!.workspace_id).toBe(ECOSYSTEM);
    expect(after).toHaveLength(5);

    // Its three links point at the records that had already landed.
    const links = (
      await q(
        `select source_entity_id, target_entity_id from relations where source_proposal_id = $1`,
        [id]
      )
    ).rows as Array<{ source_entity_id: string; target_entity_id: string }>;
    const idOf = (n: number) =>
      before.find((e) => e.title === `${PAINS[n - 1]} A`)!.id;
    expect(
      links.map((l) => [l.source_entity_id, l.target_entity_id]).sort()
    ).toEqual([1, 2, 3].map((n) => [trends[0]!.id, idOf(n)]).sort());

    const row = await receipt(id);
    expect(row.status).toBe("approved");
    expect(row.reviewed_by).toBe(USER);
    expect(row.rejection_reason).toBeNull();
    expect(row.data.failure).toBeUndefined();
    const m = row.data.materialized;
    expect(m.opCount).toBeUndefined();
    expect(m.failedOp).toBeUndefined();
    expect(m.notRun).toBeUndefined();
    expect(m.resolving).toBeUndefined();
    expect(m.byOp.t.entityId).toBe(trends[0]!.id);
    expect(m.byOp.p1.entityId).toBe(idOf(1));
    expect(Object.keys(m.byOp).sort()).toEqual(
      [
        "p1",
        "p2",
        "p3",
        "p4",
        "t",
        "t->p1:relates_to",
        "t->p2:relates_to",
        "t->p3:relates_to",
      ].sort()
    );
    expect([...m.entityIds].sort()).toEqual(after.map((e) => e.id).sort());
    expect(m.relationIds).toHaveLength(3);
    expect(m.resolutions.t).toMatchObject({
      action: "file_in_workspace",
      outcome: "filed",
      by: USER,
      workspaceId: ECOSYSTEM,
    });

    // Nothing waits any more: a second press is refused and files nothing.
    await expect(
      caller(USER).resolveItem({
        proposalId: id,
        itemRef: "t",
        action: { type: "file_in_workspace", workspaceId: ECOSYSTEM },
      })
    ).rejects.toThrow(/already decided/);
    expect(await entitiesOf(id)).toHaveLength(5);
  }, 120_000);

  it("skip leaves the trend and the links that need it out, and the receipt reads complete", async () => {
    const id = await stoppedReceipt("B");
    const result = await caller(USER).resolveItem({
      proposalId: id,
      itemRef: "t",
      action: { type: "skip" },
    });
    expect(result).toMatchObject({
      complete: true,
      outcome: "skipped",
      filed: 0,
    });
    expect(await entitiesOf(id)).toHaveLength(4);
    const row = await receipt(id);
    expect(row.status).toBe("approved");
    const m = row.data.materialized;
    expect(
      m.skipped.map((s: { key: string; reason: string }) => [s.key, s.reason])
    ).toEqual([
      ["t", "Skipped on review."],
      ["t->p1:relates_to", "Left out: it links to an item that was skipped."],
      ["t->p2:relates_to", "Left out: it links to an item that was skipped."],
      ["t->p3:relates_to", "Left out: it links to an item that was skipped."],
    ]);
    expect(m.resolutions.t.outcome).toBe("skipped");
    expect(m.byOp.t).toBeUndefined();
  }, 120_000);

  it("refuses a person outside the space and an agent caller, and changes nothing", async () => {
    const id = await stoppedReceipt("C");
    const before = await receipt(id);

    await expect(
      caller(OTHER).resolveItem({
        proposalId: id,
        itemRef: "t",
        action: { type: "skip" },
      })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
    });
    await expect(
      caller(OTHER).resolveOptions({ proposalId: id })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NOT_FOUND|FORBIDDEN/),
    });
    await expect(
      caller(USER, { agentUserId: randomUUID() }).resolveItem({
        proposalId: id,
        itemRef: "t",
        action: { type: "skip" },
      })
    ).rejects.toThrow(/An agent credential cannot approve/);

    const after = await receipt(id);
    expect(after.status).toBe("approval_failed");
    expect(after.data).toEqual(before.data);
    expect(await entitiesOf(id)).toHaveLength(4);
  }, 120_000);

  it("refuses a kind that is not available where it would land", async () => {
    const id = await stoppedReceipt("D");
    await expect(
      caller(USER).resolveItem({
        proposalId: id,
        itemRef: "t",
        action: { type: "file_in_workspace", workspaceId: FOUNDATION },
      })
    ).rejects.toThrow(/isn't available in Foundation either/);
    await expect(
      caller(USER).resolveItem({
        proposalId: id,
        itemRef: "t->p1:relates_to",
        action: { type: "use_kind", profileSlug: "pain-point" },
      })
    ).rejects.toThrow(/A link can only be skipped/);
    expect((await receipt(id)).status).toBe("approval_failed");
  }, 120_000);
});
