/**
 * A Build bundle's DRAFT PLAYBOOK and LIST are undone by the import session's
 * revert — on a real Postgres, through the real seam.
 *
 * materializeCompositeGraph (real) → buildMaterializedRecord + stampMaterialized
 * (real, into a real `proposals` row) → planProposalRevert (real) →
 * revertProposalCreations → safeRevert (real SQL) — driven by `revertSession`
 * over the session the proposal was filed in.
 *
 * The defect this pins: `create_playbook` appeared only in the record's `byOp`
 * and never in its id fields, so the planner never targeted it and a session
 * revert left the draft playbook behind (audit 03 §E). `create_view` is new and
 * rides the same record.
 *
 * Stubbed, and why: the playbook / view create DOORS (the materializer takes
 * injected callers by design; these insert rows the way the doors do) and the
 * post-commit event fan-out. The per-proposal step of `revertSession` is the
 * stored-row planner + undo, as in run-revert.pglite.test.ts (the tRPC door's
 * authority is covered by cancel-and-item-revert.pglite.test.ts).
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
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import {
  buildMaterializedRecord,
  stampMaterialized,
} from "../../proposals/stamp-materialized.js";
import { planProposalRevert } from "../../../routers/proposals/revert.js";
import { revertProposalCreations } from "../../proposals/revert-creations.js";
import {
  revertSession,
  type ProposalRevertOutput,
} from "../../focus-sessions/revert-session.js";

const USER = "user-1";

const DDL = `
  create table entities (
    id uuid primary key, user_id text not null, workspace_id uuid,
    profile_id uuid, type text not null, title text,
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
  create table focus_sessions (id uuid primary key, user_id text not null);
  create table playbooks (
    id uuid primary key, name text not null, status text not null,
    updated_at timestamptz not null default now()
  );
  create table playbook_runs (id uuid primary key, playbook_id uuid not null);
  create table views (
    id uuid primary key, name text not null, document_id uuid,
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

/** Graph ops of one Build bundle: a thing, its draft process, its list. */
const BUNDLE = [
  { op: "create_entity", ref: "t1", profileSlug: "note", title: "Recipe" },
  {
    op: "create_playbook",
    ref: "pb1",
    name: "Cook it",
    goalTemplate: "Cook {{title}}",
    subjectProfile: { profileSlug: "note" },
    status: "draft",
  },
  {
    op: "create_view",
    ref: "list1",
    name: "Recipes",
    viewType: "list",
    entityRefs: ["t1"],
  },
] as CompositeProposalOperation[];

async function fileAndApply(
  client: PGlite,
  database: Database,
  sessionId: string
) {
  const proposalId = randomUUID();
  await client.query(
    `insert into proposals (id, session_id, status, proposal_type, target_id, data)
     values ($1, $2, 'approved', 'capture.graph', $3, $4::jsonb)`,
    [
      proposalId,
      sessionId,
      randomUUID(),
      JSON.stringify({ operations: BUNDLE }),
    ]
  );
  const result = await materializeCompositeGraph(
    BUNDLE,
    {
      create: async (input: { title?: string }) => {
        const id = randomUUID();
        await client.query(
          `insert into entities (id, user_id, type, title, source_proposal_id)
           values ($1, $2, 'note', $3, $4)`,
          [id, USER, input.title ?? "Untitled", proposalId]
        );
        return { status: "created", id };
      },
    },
    { create: vi.fn() },
    undefined,
    {
      playbookCaller: {
        create: async (input) => {
          const id = randomUUID();
          await client.query(
            `insert into playbooks (id, name, status) values ($1, $2, $3)`,
            [id, input.name, input.status]
          );
          return { id };
        },
      },
      viewCaller: {
        create: async (input) => {
          const id = randomUUID();
          await client.query(`insert into views (id, name) values ($1, $2)`, [
            id,
            input.name,
          ]);
          return { id };
        },
      },
    }
  );
  await stampMaterialized({
    proposalId,
    record: buildMaterializedRecord(result),
    database,
  });
  return { proposalId, result };
}

async function revertStored(
  client: PGlite,
  database: Database,
  proposalId: string
) {
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
  const plan = planProposalRevert({
    status: row!.status,
    targetType: row!.target_type,
    targetId: row!.target_id,
    proposalType: row!.proposal_type,
    data: row!.data,
  });
  if (plan.kind !== "delete-creations") {
    throw new Error(`expected delete-creations, planner said ${plan.kind}`);
  }
  return revertProposalCreations({
    proposal: {
      id: row!.id,
      workspaceId: row!.workspace_id,
      sessionId: row!.session_id,
      data: row!.data,
    },
    plan,
    userId: USER,
    database,
  });
}

describe("a session revert undoes a bundle's draft playbook and list", () => {
  it("archives the draft playbook and deletes the list with the thing", async () => {
    const { client, database } = await freshDb();
    const sessionId = randomUUID();
    await client.query(
      `insert into focus_sessions (id, user_id) values ($1, $2)`,
      [sessionId, USER]
    );
    const { proposalId, result } = await fileAndApply(
      client,
      database,
      sessionId
    );
    const playbookId = result.playbooks[0]!.playbookId;
    const viewId = result.views[0]!.viewId;
    // The list was created over the thing the same bundle made.
    expect(result.views[0]!.entityIds).toEqual([result.entities[0]!.entityId]);

    const revertOne = vi.fn(async (id: string) => {
      const outcome = await revertStored(client, database, id);
      return {
        success: true,
        ...(outcome.skipped.length
          ? { partialFailures: outcome.skipped.map((s) => s.detail) }
          : {}),
      } as unknown as ProposalRevertOutput;
    });
    const session = await revertSession({
      sessionId,
      userId: USER,
      revertOne,
      database,
    });
    expect(session.ok).toBe(true);
    expect(revertOne.mock.calls.map(([id]) => id)).toEqual([proposalId]);

    const {
      rows: [playbook],
    } = await client.query<{ status: string }>(
      `select status from playbooks where id = $1`,
      [playbookId]
    );
    expect(playbook?.status).toBe("archived");
    const { rows: liveViews } = await client.query(
      `select id from views where id = $1`,
      [viewId]
    );
    expect(liveViews).toEqual([]);
    const { rows: liveEntities } = await client.query(
      `select id from entities where deleted_at is null`
    );
    expect(liveEntities).toEqual([]);
  });

  it("leaves a list edited after the run, and a playbook that has run, in place — and says why", async () => {
    const { client, database } = await freshDb();
    const sessionId = randomUUID();
    await client.query(
      `insert into focus_sessions (id, user_id) values ($1, $2)`,
      [sessionId, USER]
    );
    const { proposalId, result } = await fileAndApply(
      client,
      database,
      sessionId
    );
    const playbookId = result.playbooks[0]!.playbookId;
    const viewId = result.views[0]!.viewId;
    await client.query(
      `update views set updated_at = now() + interval '1 minute' where id = $1`,
      [viewId]
    );
    await client.query(
      `insert into playbook_runs (id, playbook_id) values ($1, $2)`,
      [randomUUID(), playbookId]
    );

    const outcome = await revertStored(client, database, proposalId);
    expect(
      outcome.skipped.map((s) => [s.target.kind, s.reason]).sort()
    ).toEqual([
      ["playbook", "in_use"],
      ["view", "edited_since"],
    ]);
    const { rows: views } = await client.query(
      `select id from views where id = $1`,
      [viewId]
    );
    expect(views).toHaveLength(1);
    // What was kept is still named by the record, for a later retry.
    expect(outcome.remaining.viewIds).toEqual([viewId]);
    expect(outcome.remaining.playbookIds).toEqual([playbookId]);
  });
});
