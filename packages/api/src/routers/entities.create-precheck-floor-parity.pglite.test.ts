/**
 * The capture pre-check and the create door give the SAME governance input for
 * one create — including the born-status lifecycle floor.
 *
 * MEASURED DEFECT (live, 2026-10-18): for a decision born `accepted` (a
 * done-category option) the capture pre-check asked the resolver with NO
 * lifecycle move (→ execute) while `entities.create` asked with
 * `{ intoTerminal: true }` (→ LIFECYCLE_TERMINAL, propose). Five auto-applied
 * captures each left a pending duplicate and a failed receipt.
 *
 * Both sides are driven for real on PGlite: the REAL `entities.create`
 * procedure (its gate `checkPermissionOrPropose` is recorded, not run) and the
 * REAL `captureGraphMemberProposes` (its resolver is recorded). Both read the
 * kind's lifecycle through the one `getEffectiveLifecycle` (stubbed to the
 * decision lifecycle). The door hands the gate `lifecycleMove`, which the gate
 * forwards to the same resolver (`permission-check.ts`, the agent ladder).
 *
 * Rows that rule out a wrong rule:
 *  - born `accepted` ⇒ both carry `{ intoTerminal: true, humanOnly: false }`
 *    (the defect: the pre-check carried none);
 *  - born `proposed` (open) ⇒ neither carries one (rules out "every decision");
 *  - status left to the kind's default ⇒ both read the default.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  gate: vi.fn(),
  resolve: vi.fn(),
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
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.gate,
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
  isJoinGate: vi.fn(() => false),
}));
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: h.resolve,
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
  getBoss: () => ({ send: async () => null }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { ProfileResolutionService } from "@synap/database";
import { entitiesRouter } from "./entities.js";
import { captureGraphMemberProposes } from "../services/capture-agent/capture-graph-governance.js";

const USER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
let DECISION_ID = "";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'u@x.test')`, [USER]);
  await q(
    `insert into workspaces (id, name, owner_id, workspace_type, settings) values ($1,'Builder',$2,'team','{}'::jsonb)`,
    [WS, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, USER]
  );
  const { rows } = await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints, default_values)
     values (gen_random_uuid(),'decision','Decision','kind','system','pod',null,true,'{}'::jsonb,'{"decisionStatus":"accepted"}'::jsonb) returning id`
  );
  DECISION_ID = (rows[0] as { id: string }).id;
}, 120_000);

const LIFECYCLE = {
  propertySlug: "decisionStatus",
  propertyDefId: "def-decision-status",
  declaredOnProfileId: "",
  unclassified: [],
  options: [
    { key: "proposed", category: "open" },
    { key: "accepted", category: "done" },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(
    ProfileResolutionService.prototype,
    "getEffectiveLifecycle"
  ).mockImplementation(async (profileId: string) =>
    profileId === DECISION_ID
      ? ({ ...LIFECYCLE, declaredOnProfileId: DECISION_ID } as never)
      : null
  );
  h.gate.mockReset().mockResolvedValue({ allowed: true });
  h.resolve.mockReset().mockResolvedValue({ decision: "execute" });
});

/** The lifecycle move the create DOOR hands its gate. */
async function doorMove(properties: Record<string, unknown>) {
  await entitiesRouter
    .createCaller({
      authenticated: true,
      userId: USER,
      workspaceId: WS,
    } as never)
    .create({
      profileSlug: "decision",
      title: `Decision ${randomUUID()}`,
      properties,
      source: "agent",
    } as never);
  expect(h.gate).toHaveBeenCalledTimes(1);
  return (h.gate.mock.calls[0]![0] as { lifecycleMove?: unknown })
    .lifecycleMove;
}

/** The lifecycle move the capture PRE-CHECK hands the resolver. */
async function precheckMove(properties: Record<string, unknown>) {
  await captureGraphMemberProposes({
    agentUserId: AGENT,
    userId: USER,
    workspaceId: WS,
    operations: [
      {
        op: "create_entity",
        ref: "e0",
        profileSlug: "decision",
        title: "Decision",
        properties,
      },
    ] as never,
  });
  const entityCreate = h.resolve.mock.calls
    .map((c) => c[0] as { subjectType: string; lifecycleMove?: unknown })
    .find((a) => a.subjectType === "entity");
  expect(entityCreate).toBeDefined();
  return entityCreate!.lifecycleMove;
}

describe("pre-check and create door agree on a create's born-status floor", () => {
  it("born `accepted` (done): both carry the terminal move", async () => {
    const door = await doorMove({ decisionStatus: "accepted" });
    const pre = await precheckMove({ decisionStatus: "accepted" });
    expect(door).toEqual({ intoTerminal: true, humanOnly: false });
    expect(pre).toEqual(door);
  });

  it("born `proposed` (open): neither carries a move", async () => {
    const door = await doorMove({ decisionStatus: "proposed" });
    const pre = await precheckMove({ decisionStatus: "proposed" });
    expect(door).toBeUndefined();
    expect(pre).toBeUndefined();
  });

  it("no status given: both read the kind's default (`accepted`)", async () => {
    const door = await doorMove({});
    const pre = await precheckMove({});
    expect(door).toEqual({ intoTerminal: true, humanOnly: false });
    expect(pre).toEqual(door);
  });
});
