/**
 * A capture graph that STOPS part-way records exactly what it filed.
 *
 * Live 2026-10-22 (proposal e8fc00d6, an auto-apply receipt): a graph's fifth
 * entity named the kind `trend`, which exists only in another space
 * (Ecosystem), not the one it was filed into (Foundation). The four entities
 * before it landed, each carrying the receipt's id, yet the receipt read
 * `approval_failed`, `materialized.entityIds: []` and `errorClass:
 * target_missing`: "it failed, nothing was created, what it points at no
 * longer exists". All three were false.
 *
 * Driven through the REAL `materializeAgentGraphUnderReceipt` (the auto-apply
 * door's own materializer), the REAL `materializeCompositeGraph`, the REAL
 * `entities.create` (profile resolution, the kind-missing lookup) and the
 * REAL `runMaterializationUnderReceipt` writer, on PGlite with every table.
 * Stubbed, as in the other `entities.create` PGlite suites: governance
 * (allow), audit, the read-only guard and side effects.
 *
 * The graph: p1, p2 (a kind of THIS space), t (a kind only Ecosystem has),
 * p3, then the relation p1→p2. Rows that each rule out a wrong record:
 *  - p1 and p2 are named as filed WITH the ids of rows that exist (rules out
 *    the placeholder `entityIds: []`, and a record that names ids nobody
 *    wrote);
 *  - t is the failed op, class `kind_missing`, naming Ecosystem (rules out
 *    `target_missing`, and a lookup that names no other space);
 *  - p3 and the relation are `notRun` (rules out reporting them as failed or
 *    filed); Hidden, a space holding `trend` that the user cannot read, is
 *    never named.
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
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { materializeAgentGraphUnderReceipt } from "./submit-capture-graph.js";

const USER = randomUUID();
const OTHER = randomUUID();
const FOUNDATION = randomUUID();
const ECOSYSTEM = randomUUID();
const HIDDEN = randomUUID();
const RECEIPT = randomUUID();

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

const OPERATIONS = [
  {
    op: "create_entity",
    ref: "p1",
    profileSlug: "pain-point",
    title: "Agent memory keeps contradictory old facts",
    targetWorkspaceId: FOUNDATION,
  },
  {
    op: "create_entity",
    ref: "p2",
    profileSlug: "pain-point",
    title: "Deleting AI memory leaves the raw messages",
    targetWorkspaceId: FOUNDATION,
  },
  {
    op: "create_entity",
    ref: "t",
    profileSlug: "trend",
    title: "Agent-memory users now demand deletion",
  },
  {
    op: "create_entity",
    ref: "p3",
    profileSlug: "pain-point",
    title: "No portable standard to move AI memory",
    targetWorkspaceId: FOUNDATION,
  },
  {
    op: "create_relation",
    type: "relates_to",
    sourceRef: "p1",
    targetRef: "p2",
  },
] as const;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // The schema's plain-column UNIQUE indexes too: writers' ON CONFLICT targets
  // need them (entity_external_links' (provider, external_id,
  // nango_connection_id) is hit by every entity the graph creates).
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
  // The receipt, inserted BEFORE materialization with the honest empty set —
  // exactly as `submitCaptureGraph`'s auto-apply path writes it.
  await q(
    `insert into proposals (id, created_by, status, proposal_type, target_type, target_id, workspace_id, data)
     values ($1,$2,'auto_approved','capture.graph','entity',$3,$4,$5::jsonb)`,
    [
      RECEIPT,
      USER,
      randomUUID(),
      FOUNDATION,
      JSON.stringify({
        operations: OPERATIONS,
        graphSource: "capture",
        materialized: { entityIds: [] },
      }),
    ]
  );
}, 120_000);

describe("a capture graph that stops part-way records what it filed", () => {
  it("names what landed, the op that failed (kind_missing) and what never ran", async () => {
    const receiptData = {
      operations: OPERATIONS,
      graphSource: "capture",
      materialized: { entityIds: [] as string[] },
    };
    await expect(
      materializeAgentGraphUnderReceipt(
        {
          db,
          authenticated: true,
          userId: USER,
          workspaceId: FOUNDATION,
          workspaceRole: "owner",
          sessionId: null,
          governanceProposalId: RECEIPT,
        },
        {
          receipt: { id: RECEIPT, data: receiptData },
          operations: OPERATIONS as never,
          agentUserId: null,
          source: "agent",
          idempotencyKey: "stopped-run-test",
        }
      )
    ).rejects.toThrow("Profile not found: trend");

    const { rows } = await q(
      `select status, rejection_reason, data from proposals where id = $1`,
      [RECEIPT]
    );
    const row = rows[0] as {
      status: string;
      rejection_reason: string;
      data: Record<string, any>;
    };
    expect(row.status).toBe("approval_failed");

    // Ops 1-2 landed: real rows, named in the record by op.
    const created = (
      await q(`select id, title from entities where source_proposal_id = $1`, [
        RECEIPT,
      ])
    ).rows as Array<{ id: string; title: string }>;
    expect(created.map((e) => e.title).sort()).toEqual(
      [OPERATIONS[0].title, OPERATIONS[1].title].sort()
    );
    const idOf = (title: string) => created.find((e) => e.title === title)!.id;
    const m = row.data.materialized;
    expect(m.opCount).toBe(5);
    expect([...m.entityIds].sort()).toEqual(created.map((e) => e.id).sort());
    expect(m.byOp.p1).toMatchObject({
      op: "create_entity",
      entityId: idOf(OPERATIONS[0].title),
      linked: false,
    });
    expect(m.byOp.p2).toMatchObject({
      op: "create_entity",
      entityId: idOf(OPERATIONS[1].title),
    });
    expect(Object.keys(m.byOp).sort()).toEqual(["p1", "p2"]);

    // Op 3 failed, for the true reason, naming where the kind exists.
    expect(m.failedOp).toEqual({
      key: "t",
      opIndex: 2,
      op: "create_entity",
      title: OPERATIONS[2].title,
      reason: row.rejection_reason,
      errorClass: "kind_missing",
    });
    expect(row.data.failure.errorClass).toBe("kind_missing");
    expect(row.data.failure.kindMissing).toEqual({
      profileSlug: "trend",
      kindName: "Trend",
      workspaceId: FOUNDATION,
      workspaceName: "Foundation",
      foundIn: [{ workspaceId: ECOSYSTEM, name: "Ecosystem" }],
    });
    expect(row.rejection_reason).toBe(
      `Couldn't file it — the kind "Trend" isn't available in Foundation. It exists in Ecosystem.`
    );
    // A space the user cannot read is never named.
    expect(JSON.stringify(row.data)).not.toContain("Hidden");

    // The rest never ran.
    expect(m.notRun.map((r: { key: string }) => r.key)).toEqual([
      "p3",
      "p1->p2:relates_to",
    ]);
    expect(m.skipped).toEqual([]);
    // The existing reader's field is kept.
    expect(row.data.materializationError).toBe("Profile not found: trend");
  });
});
