/**
 * A Library rebuild's `update_*` ops are undone by revert — on a real Postgres,
 * through the real seam, for EVERY update kind.
 *
 * materializeCompositeGraph (real) → buildMaterializedRecord + stampMaterialized
 * (real, into a real `proposals` row) → planProposalRevert / planProposalOpRevert
 * (real) → revertProposalCreations → safeRevert (real SQL).
 *
 * What it pins:
 *   - each update records `{before, after}` (config rows as `rowPatches` + the
 *     op's `byOp.update`; the entity as the ONE entity diff) and revert puts
 *     `before` back — the row is changed back, never deleted;
 *   - a field somebody edited after the update is KEPT and named
 *     (`edited_since`), exactly like an undo of a creation;
 *   - one update can be undone on its own (`planProposalOpRevert`).
 *
 * Stubbed, and why: the update DOORS (the materializer takes an injected
 * `updateCaller` by design; this one writes the row with SQL and reads the
 * patched columns around the write, the contract `composite-update-caller.ts`
 * keeps) and the post-commit event fan-out.
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../../utils/property-relation-sync.js", () => ({
  syncRelationToPropertyOnDelete: vi.fn(async () => undefined),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { proposals, type db as DatabaseHandle } from "@synap/database";
import type {
  CompositeProposalOperation,
  CompositeUpdateOperation,
} from "@synap-core/types/proposals";
import {
  materializeCompositeGraph,
  type CompositeUpdateCaller,
} from "../../../utils/materialize-composite.js";
import {
  buildMaterializedRecord,
  stampMaterialized,
} from "../../proposals/stamp-materialized.js";
import {
  planProposalOpRevert,
  planProposalRevert,
} from "../../../routers/proposals/revert.js";
import { revertProposalCreations } from "../../proposals/revert-creations.js";

const USER = "user-1";

const DDL = `
  create table entities (
    id uuid primary key, user_id text not null, workspace_id uuid,
    profile_id uuid, type text not null, title text, preview text,
    document_id uuid, properties jsonb not null default '{}'::jsonb,
    source_proposal_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  );
  create table relations (
    id uuid primary key, user_id text not null, workspace_id uuid,
    source_entity_id uuid, target_entity_id uuid, type text not null,
    source_proposal_id uuid, created_at timestamptz not null default now()
  );
  create table entity_facets (
    id uuid primary key, entity_id uuid not null, user_id text not null,
    source_proposal_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  );
  create table links (
    id uuid primary key default gen_random_uuid(), workspace_id uuid,
    from_type text not null, from_id text not null,
    to_type text not null, to_id text not null, link_type text not null
  );
  create table proposals (
    id uuid primary key, workspace_id text, session_id uuid,
    status text not null, proposal_type text not null,
    target_type text not null default 'entity', target_id text not null,
    data jsonb not null, external_dispatched_at timestamptz,
    created_at timestamptz not null default now()
  );
  create table skills (
    id uuid primary key, name text not null, description text, body text,
    metadata jsonb, status text not null default 'active',
    updated_at timestamptz not null default now()
  );
  create table automations (
    id uuid primary key, name text not null, description text,
    status text not null default 'draft',
    updated_at timestamptz not null default now()
  );
  create table playbooks (
    id uuid primary key, name text not null, description text,
    goal_template text not null, status text not null default 'draft',
    updated_at timestamptz not null default now()
  );
  create table views (
    id uuid primary key, name text not null, description text,
    config jsonb, document_id uuid,
    updated_at timestamptz not null default now()
  );
`;

type Database = typeof DatabaseHandle;

async function freshDb() {
  const client = new PGlite();
  await client.exec(DDL);
  const database = drizzle(client, {
    schema: { proposals },
  }) as unknown as Database;
  return { client, database };
}

/** The rows an earlier Build made — what the rebuild changes. */
async function seedBuilt(client: PGlite) {
  const ids = {
    skill: randomUUID(),
    rule: randomUUID(),
    automation: randomUUID(),
    playbook: randomUUID(),
    view: randomUUID(),
    container: randomUUID(),
  };
  await client.query(
    `insert into skills (id, name, description, body) values ($1, 'Recipes tool', 'old', 'old body')`,
    [ids.skill]
  );
  await client.query(
    `insert into skills (id, name, description, body, metadata) values ($1, 'Rule', 'cook weekly', 'cook weekly', $2::jsonb)`,
    [ids.rule, JSON.stringify({ rule: { intent: "cook weekly" } })]
  );
  await client.query(
    `insert into automations (id, name, description) values ($1, 'When a recipe lands', 'old')`,
    [ids.automation]
  );
  await client.query(
    `insert into playbooks (id, name, description, goal_template) values ($1, 'Cook it', 'old', 'Cook {title}')`,
    [ids.playbook]
  );
  await client.query(
    `insert into views (id, name, config) values ($1, 'Recipes', $2::jsonb)`,
    [ids.view, JSON.stringify({ membersOf: ids.container })]
  );
  await client.query(
    `insert into entities (id, user_id, type, title, preview, properties)
     values ($1, $2, 'note', 'Recipes', 'Your group note: old', '{"isContainer":true}'::jsonb)`,
    [ids.container, USER]
  );
  return ids;
}

function rebuildOps(ids: Awaited<ReturnType<typeof seedBuilt>>) {
  return [
    {
      op: "update_skill",
      ref: "tool",
      skillId: ids.skill,
      patch: { body: "new body" },
    },
    {
      op: "update_rule",
      ref: "rule",
      ruleId: ids.rule,
      patch: { intent: "cook twice a week" },
    },
    {
      op: "update_automation",
      ref: "rule_when",
      automationId: ids.automation,
      patch: { description: "new" },
    },
    {
      op: "update_playbook",
      ref: "template",
      playbookId: ids.playbook,
      patch: { goalTemplate: "Cook and rate {title}" },
    },
    {
      op: "update_view",
      ref: "list",
      viewId: ids.view,
      patch: { name: "Recipes (all)", config: { density: "compact" } },
    },
    {
      op: "update_entity",
      ref: "group",
      entityId: ids.container,
      patch: { description: "Your group note: new" },
    },
  ] as CompositeProposalOperation[];
}

const TABLE: Record<string, [string, string]> = {
  update_skill: ["skills", "skillId"],
  update_rule: ["skills", "ruleId"],
  update_automation: ["automations", "automationId"],
  update_playbook: ["playbooks", "playbookId"],
  update_view: ["views", "viewId"],
};
const COLUMN: Record<string, string> = {
  name: "name",
  description: "description",
  body: "body",
  goalTemplate: "goal_template",
  config: "config",
  metadata: "metadata",
};

/** SQL stand-in for the update doors — same before/after contract. */
function sqlUpdateCaller(client: PGlite): CompositeUpdateCaller {
  const read = async (table: string, id: string, columns: string[]) => {
    const {
      rows: [row],
    } = await client.query<Record<string, unknown>>(
      `select ${columns.map((c) => `${COLUMN[c]} as "${c}"`).join(", ")} from ${table} where id = $1`,
      [id]
    );
    return row ?? {};
  };
  return {
    apply: async (op: CompositeUpdateOperation) => {
      if (op.op === "update_entity") {
        const snap = async () => {
          const {
            rows: [row],
          } = await client.query<Record<string, unknown>>(
            `select title, preview, properties from entities where id = $1`,
            [op.entityId]
          );
          return row!;
        };
        const before = await snap();
        await client.query(
          `update entities set preview = $2, updated_at = now() where id = $1`,
          [op.entityId, op.patch.description]
        );
        return { before, after: await snap() };
      }
      const [table, idKey] = TABLE[op.op]!;
      const id = (op as unknown as Record<string, string>)[idKey]!;
      let patch = op.patch as Record<string, unknown>;
      if (op.op === "update_rule") {
        patch = {
          name: op.patch.intent,
          description: op.patch.intent,
          body: op.patch.intent,
          metadata: { rule: { intent: op.patch.intent } },
        };
      }
      if (op.op === "update_view" && op.patch.config) {
        const { config } = await read(table, id, ["config"]);
        patch = {
          ...patch,
          config: { ...(config as object), ...op.patch.config },
        };
      }
      const columns = Object.keys(patch);
      const before = await read(table, id, columns);
      await client.query(
        `update ${table} set ${columns
          .map((c, i) => `${COLUMN[c]} = $${i + 2}`)
          .join(", ")}, updated_at = now() where id = $1`,
        [
          id,
          ...columns.map((c) =>
            typeof patch[c] === "object" ? JSON.stringify(patch[c]) : patch[c]
          ),
        ]
      );
      return { before, after: await read(table, id, columns) };
    },
  };
}

async function fileAndApply(client: PGlite, database: Database) {
  const ids = await seedBuilt(client);
  const ops = rebuildOps(ids);
  const proposalId = randomUUID();
  await client.query(
    `insert into proposals (id, status, proposal_type, target_id, data)
     values ($1, 'approved', 'capture.graph', $2, $3::jsonb)`,
    [proposalId, randomUUID(), JSON.stringify({ operations: ops })]
  );
  const result = await materializeCompositeGraph(
    ops,
    { create: vi.fn() },
    { create: vi.fn() },
    undefined,
    { updateCaller: sqlUpdateCaller(client) }
  );
  await stampMaterialized({
    proposalId,
    record: buildMaterializedRecord(result),
    database,
  });
  return { ids, proposalId, result };
}

async function storedRow(client: PGlite, proposalId: string) {
  const {
    rows: [row],
  } = await client.query<{
    id: string;
    status: string;
    target_type: string;
    target_id: string;
    proposal_type: string;
    workspace_id: string | null;
    session_id: string | null;
    data: unknown;
  }>(`select * from proposals where id = $1`, [proposalId]);
  return row!;
}

async function revertWhole(
  client: PGlite,
  database: Database,
  proposalId: string
) {
  const row = await storedRow(client, proposalId);
  const plan = planProposalRevert({
    status: row.status,
    targetType: row.target_type,
    targetId: row.target_id,
    proposalType: row.proposal_type,
    data: row.data,
  });
  if (plan.kind !== "delete-creations") {
    throw new Error(`expected delete-creations, planner said ${plan.kind}`);
  }
  return revertProposalCreations({
    proposal: {
      id: row.id,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      data: row.data,
    },
    plan,
    userId: USER,
    database,
  });
}

async function one<T>(client: PGlite, sql: string, id: string): Promise<T> {
  const {
    rows: [row],
  } = await client.query<T>(sql, [id]);
  return row!;
}

describe("a rebuild's update ops are undone by revert", () => {
  it("applies every update kind, records {before, after}, and changes nothing else", async () => {
    const { client, database } = await freshDb();
    const { ids, proposalId, result } = await fileAndApply(client, database);

    expect(result.updates.map((u) => u.op).sort()).toEqual(
      [
        "update_automation",
        "update_entity",
        "update_playbook",
        "update_rule",
        "update_skill",
        "update_view",
      ].sort()
    );
    // The List's `membersOf` survived the config merge.
    const view = await one<{ config: Record<string, unknown> }>(
      client,
      `select config from views where id = $1`,
      ids.view
    );
    expect(view.config).toEqual({
      membersOf: ids.container,
      density: "compact",
    });

    const row = await storedRow(client, proposalId);
    const record = (row.data as { materialized: Record<string, unknown> })
      .materialized as {
      rowPatches: Array<{ kind: string; id: string; before: unknown }>;
      propertyDiffs: Array<{ entityId: string }>;
      byOp: Record<string, { op: string; update?: { before: unknown } }>;
      entityIds: string[];
    };
    expect(record.rowPatches.map((p) => p.kind).sort()).toEqual([
      "automation",
      "playbook",
      "rule",
      "skill",
      "view",
    ]);
    expect(record.byOp.tool).toMatchObject({
      op: "update_skill",
      update: { before: { body: "old body" } },
    });
    expect(record.propertyDiffs.map((d) => d.entityId)).toEqual([
      ids.container,
    ]);
    // An update creates nothing: no row is ever named for deletion.
    expect(record.entityIds).toEqual([]);
  });

  it("restores every row's before — none is deleted", async () => {
    const { client, database } = await freshDb();
    const { ids, proposalId } = await fileAndApply(client, database);

    const outcome = await revertWhole(client, database, proposalId);
    expect(outcome.skipped).toEqual([]);

    expect(
      await one(client, `select body from skills where id = $1`, ids.skill)
    ).toEqual({ body: "old body" });
    expect(
      await one(
        client,
        `select name, body, metadata from skills where id = $1`,
        ids.rule
      )
    ).toEqual({
      name: "Rule",
      body: "cook weekly",
      metadata: { rule: { intent: "cook weekly" } },
    });
    expect(
      await one(
        client,
        `select description from automations where id = $1`,
        ids.automation
      )
    ).toEqual({ description: "old" });
    expect(
      await one(
        client,
        `select goal_template from playbooks where id = $1`,
        ids.playbook
      )
    ).toEqual({ goal_template: "Cook {title}" });
    expect(
      await one(
        client,
        `select name, config from views where id = $1`,
        ids.view
      )
    ).toEqual({ name: "Recipes", config: { membersOf: ids.container } });
    expect(
      await one(
        client,
        `select preview, deleted_at from entities where id = $1`,
        ids.container
      )
    ).toEqual({ preview: "Your group note: old", deleted_at: null });
    expect(outcome.remaining.rowPatches).toEqual([]);
  });

  it("keeps a field somebody edited after the update — and says why", async () => {
    const { client, database } = await freshDb();
    const { ids, proposalId } = await fileAndApply(client, database);
    await client.query(`update skills set body = 'mine now' where id = $1`, [
      ids.skill,
    ]);

    const outcome = await revertWhole(client, database, proposalId);
    expect(outcome.skipped.map((s) => [s.target.kind, s.reason])).toEqual([
      ["row_patch", "edited_since"],
    ]);
    expect(
      await one(client, `select body from skills where id = $1`, ids.skill)
    ).toEqual({ body: "mine now" });
    // The others were restored all the same.
    expect(
      await one(
        client,
        `select description from automations where id = $1`,
        ids.automation
      )
    ).toEqual({ description: "old" });
    // The kept change stays on the record, for a later retry.
    expect(outcome.remaining.rowPatches?.map((p) => [p.kind, p.id])).toEqual([
      ["skill", ids.skill],
    ]);
  });

  it("refuses a stored record that names a column an update never writes", async () => {
    const { client, database } = await freshDb();
    const { ids, proposalId } = await fileAndApply(client, database);
    // Tamper: the record now asks the undo to write `status`.
    await client.query(
      `update proposals set data = jsonb_set(data, '{materialized,rowPatches}',
         (select jsonb_agg(case when p->>'kind' = 'skill'
            then jsonb_set(jsonb_set(p, '{before,status}', '"archived"'), '{after,status}', '"active"')
            else p end)
          from jsonb_array_elements(data->'materialized'->'rowPatches') p))
       where id = $1`,
      [proposalId]
    );
    const outcome = await revertWhole(client, database, proposalId);
    expect(outcome.skipped.map((s) => [s.target.kind, s.reason])).toEqual([
      ["row_patch", "not_owned"],
    ]);
    expect(
      await one(
        client,
        `select status, body from skills where id = $1`,
        ids.skill
      )
    ).toEqual({ status: "active", body: "new body" });
  });

  it("undoes ONE update on its own", async () => {
    const { client, database } = await freshDb();
    const { ids, proposalId } = await fileAndApply(client, database);
    const row = await storedRow(client, proposalId);
    const input = {
      status: row.status,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      data: row.data,
    };

    for (const [opKey, sql, id, expected] of [
      [
        "template",
        `select goal_template from playbooks where id = $1`,
        ids.playbook,
        { goal_template: "Cook {title}" },
      ],
      [
        "group",
        `select preview from entities where id = $1`,
        ids.container,
        { preview: "Your group note: old" },
      ],
    ] as const) {
      const opPlan = planProposalOpRevert(input, opKey);
      if (opPlan.kind !== "op") throw new Error(`${opKey}: ${opPlan.kind}`);
      const outcome = await revertProposalCreations({
        proposal: {
          id: row.id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          data: row.data,
        },
        plan: opPlan.plan,
        userId: USER,
        database,
      });
      expect(outcome.skipped).toEqual([]);
      expect(await one(client, sql, id)).toEqual(expected);
    }
    // The other updates are untouched.
    expect(
      await one(client, `select body from skills where id = $1`, ids.skill)
    ).toEqual({ body: "new body" });
  });
});
