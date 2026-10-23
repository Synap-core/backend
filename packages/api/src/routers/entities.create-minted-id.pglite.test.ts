/**
 * A create lands under the id it was minted with, so the `proposedEntityId`
 * an agent is handed resolves once its proposal is approved.
 *
 * MEASURED DEFECT (live, 2026-10-19): proposal a45e9a3a minted 00348b58
 * (stored as `data.data.id`, returned to the agent as `proposedEntityId`) and
 * its approval landed the entity as b0588fc6: `entities.create` never passed
 * the minted id to `EntityRepository.create`, so the database minted another.
 *
 * Driven on PGlite through the REAL `entity/create` approval executor into the
 * REAL `entities.create` (its gate recorded as granted, side effects stubbed).
 *
 * Rows that rule out a wrong rule:
 *  - approving lands the entity AS the minted id (the defect: a new id);
 *  - re-running the same approval (a replay after a later step failed)
 *    returns that row: one row, no primary-key crash, no same-name refusal;
 *  - a direct create naming its own id lands as it;
 *  - naming ANOTHER person's entity id mints a fresh one and leaves theirs
 *    untouched (rules out "reuse whatever row has the id");
 *  - naming a DELETED own entity's id mints a fresh one (rules out reviving
 *    or crashing on a soft-deleted row).
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
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
  isJoinGate: vi.fn(() => false),
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
import { entitiesRouter } from "./entities.js";
import { proposalExecRegistry } from "./proposals/execution-registry.js";
import { registerEntityExecutors } from "./proposals/executors/entity.js";
import type { ProposalExecutorArgs } from "./proposals/execution-registry.js";

const OWNER = randomUUID();
const OTHER = randomUUID();
let NOTE_PROFILE = "";

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
const rowsWithId = async (id: string) =>
  (await q(`select id, user_id, title from entities where id = $1`, [id]))
    .rows as Array<{ id: string; user_id: string; title: string }>;
const countTitled = async (title: string) =>
  (
    (
      await q(`select count(*)::int as n from entities where title = $1`, [
        title,
      ])
    ).rows[0] as { n: number }
  ).n;

const caller = () =>
  entitiesRouter.createCaller({
    authenticated: true,
    userId: OWNER,
    workspaceId: null,
  } as never);

const deps = {
  reportProposalOutcome: vi.fn(),
  emitProposalReviewed: vi.fn(),
  stampProjectMembership: vi.fn(async () => {}),
} as unknown as ProposalExecutorArgs["deps"];

function approve(proposalId: string, minted: string, title: string) {
  const exec = proposalExecRegistry.resolveExact("entity/create");
  if (!exec) throw new Error("entity/create executor is not registered");
  const data = {
    requestId: `r-${proposalId}`,
    source: "agent",
    targetType: "entity",
    targetId: minted,
    changeType: "create",
    data: { id: minted, profileSlug: "note", title, resolvedWorkspaceId: null },
  };
  return exec.execute({
    proposal: {
      id: proposalId,
      targetType: "entity",
      targetId: minted,
      proposalType: "create",
      workspaceId: null,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      subjectUserId: OWNER,
      sourceMessageId: null,
      data,
    },
    payload: data as never,
    userId: OWNER,
    input: { proposalId },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps,
  } as unknown as ProposalExecutorArgs);
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  for (const [id, email] of [
    [OWNER, "owner@x.test"],
    [OTHER, "other@x.test"],
  ])
    await q(`insert into users (id, email) values ($1, $2)`, [id, email]);
  const { rows } = await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, workspace_id, is_active, ui_hints)
     values (gen_random_uuid(),'note','Note','kind','system','pod',null,true,'{}'::jsonb) returning id`
  );
  NOTE_PROFILE = (rows[0] as { id: string }).id;
  registerEntityExecutors();
}, 120_000);

describe("a create lands under its minted id", () => {
  it("approving a proposal lands the entity AS its proposedEntityId", async () => {
    const minted = randomUUID();
    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by)
       values ($1, null, 'entity', $2, 'create', '{}'::jsonb, 'pending', $3)`,
      [proposalId, minted, OWNER]
    );
    await approve(proposalId, minted, "Approved note");
    expect(await rowsWithId(minted)).toHaveLength(1);
    expect(await countTitled("Approved note")).toBe(1);
  });

  it("replaying the same approval returns that row: one row, no crash", async () => {
    const minted = randomUUID();
    const proposalId = randomUUID();
    await approve(proposalId, minted, "Replayed note");
    await expect(
      approve(proposalId, minted, "Replayed note")
    ).resolves.toBeDefined();
    expect(await countTitled("Replayed note")).toBe(1);
    expect(await rowsWithId(minted)).toHaveLength(1);
  });

  it("a direct create naming its own id lands as it", async () => {
    const minted = randomUUID();
    const res = (await caller().create({
      proposedEntityId: minted,
      profileSlug: "note",
      title: "Direct note",
    } as never)) as { id: string };
    expect(res.id).toBe(minted);
  });

  it("another person's id is never reused, and their row is untouched", async () => {
    const theirs = randomUUID();
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties)
       values ($1, $2, null, $3, 'note', 'Their note', '{}'::jsonb)`,
      [theirs, OTHER, NOTE_PROFILE]
    );
    const res = (await caller().create({
      proposedEntityId: theirs,
      profileSlug: "note",
      title: "Mine, not theirs",
    } as never)) as { id: string; deduplicated?: boolean };
    expect(res.id).not.toBe(theirs);
    expect(res.deduplicated).toBeUndefined();
    expect(await rowsWithId(theirs)).toEqual([
      { id: theirs, user_id: OTHER, title: "Their note" },
    ]);
    expect(await rowsWithId(res.id)).toHaveLength(1);
  });

  it("a deleted own entity's id mints a fresh one", async () => {
    const gone = randomUUID();
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, deleted_at)
       values ($1, $2, null, $3, 'note', 'Gone note', '{}'::jsonb, now())`,
      [gone, OWNER, NOTE_PROFILE]
    );
    const res = (await caller().create({
      proposedEntityId: gone,
      profileSlug: "note",
      title: "Fresh after delete",
    } as never)) as { id: string };
    expect(res.id).not.toBe(gone);
    expect(await rowsWithId(res.id)).toHaveLength(1);
  });
});
