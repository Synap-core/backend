/**
 * "MAKE IT A GOAL" on PGlite (work model D2 part 2, W5b) — the REAL convert
 * door (`convertEntityToGoal`) through the REAL start door (`startTrack` with
 * `fromEntity`), the REAL access registry (the entity and the project are
 * read through the caller's floor), the REAL link writer (`createLinks` — the
 * `promoted_to` edge is what makes "already a goal" true), the REAL status
 * write for an ended entity, and the REAL `track/create` approval replay.
 *
 * Pinned, each by an input where a wrong rule and the right one disagree:
 *   - an OKR's key results become measured criteria; ONE key result rides the
 *     end state (a goal has none or 2–5); an achieved OKR's ride it too
 *     (`met` needs every criterion met);
 *   - the edge is written, so a second conversion is CONFLICT (a rule
 *     reading the kind alone would convert twice);
 *   - achieved → born closed `met` by the person; abandoned → dropped;
 *   - an agent's conversion of an ended entity is FORCED to a proposal and
 *     writes nothing; its replay creates, links and closes as the approver;
 *   - the entity is never changed.
 *
 * Stubbed, only at infrastructure seams: `checkPermissionOrPropose` (an agent
 * proposes, a person is granted — the call is asserted), `emitSideEffects`,
 * the EventRepository append.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 120_000 });

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf8"
  );

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
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
    EventRepository: class {
      async append() {}
    },
  };
});

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    if (opts.agentUserId) {
      return {
        granted: false,
        proposalId: randomUUID(),
        proposalType: `${opts.subjectType}.${opts.action}`,
        summary: "",
        reasoning: "",
        reviewPath: "/open/x",
        reviewUrl: "https://pod/open/x",
      };
    }
    return { granted: true };
  },
  proposedMessageFor: (_t: string, fallback: string) => fallback,
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: async () => {},
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { convertEntityToGoal } from "../convert-to-goal.js";
import { getTrack, loadTrackView } from "../tracks-service.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerTrackExecutors } from "../../../routers/proposals/executors/track.js";
import type { ProposalExecutorArgs } from "../../../routers/proposals/execution-registry.js";

const USER = "user-1";
const AGENT = "agent-1";
const WS = randomUUID();
const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "metadata" ||
            c.name === "settings" ||
            c.name === "properties"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const human = { userId: USER };
const agent = { userId: USER, agentUserId: AGENT, isHubProtocol: true };

/** A profile id per kind. */
const profileIds = new Map<string, string>();

async function entity(
  kind: string,
  title: string,
  properties: Record<string, unknown>,
  opts: { projects?: string[]; statusCategory?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, status_category, system_data)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, '{}'::jsonb)`,
    [
      id,
      USER,
      WS,
      profileIds.get(kind),
      kind,
      title,
      JSON.stringify(properties),
      opts.statusCategory ?? null,
    ]
  );
  for (const p of opts.projects ?? [PROJECT]) {
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, metadata)
       values ($1, $2, $3, $4, $5, 'belongs_to_project', '{}'::jsonb)`,
      [randomUUID(), USER, WS, id, p]
    );
  }
  return id;
}

async function promotedTo(entityId: string) {
  return (
    await q<{ to_id: string; workspace_id: string | null }>(
      `select to_id, workspace_id from links
        where from_type = 'entity' and from_id = $1 and to_type = 'track' and link_type = 'promoted_to'`,
      [entityId]
    )
  ).rows;
}

async function entityRow(id: string) {
  return (
    await q<{ properties: unknown; title: string; updated_at: unknown }>(
      `select properties, title, updated_at from entities where id = $1`,
      [id]
    )
  ).rows[0];
}

const OKR = {
  "okr-status": "Active",
  "okr-quarter": "Q4 2026",
  "okr-confidence": "High",
  "okr-notes": "Make the newsletter a lead engine.",
  "kr1-label": "Qualified leads",
  "kr1-target": 40,
  "kr1-current": 12,
  "kr1-unit": "per month",
  "kr2-label": "Open rate",
  "kr2-target": 45,
  "kr2-unit": "%",
  "kr3-label": "Paying subscribers",
  "kr3-target": 200,
};

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  for (const t of tables) {
    const name = getTableConfig(t).name;
    // The REAL shapes for these two come from their migrations below.
    if (name === "project_tracks" || name === "track_participants") continue;
    await h.client!.exec(ddlFor(t));
  }
  await h.client!.exec(`
    create table project_tracks (
      id uuid primary key default gen_random_uuid(),
      project_id uuid not null references projects(id) on delete cascade,
      user_id text not null,
      playbook_id uuid references playbooks(id) on delete set null,
      name text not null,
      definition_snapshot jsonb not null default '{}'::jsonb,
      method_version text not null default '1',
      current_stage text,
      status text not null default 'active'
        check (status in ('active','paused','completed','archived')),
      params jsonb not null default '{}'::jsonb,
      stage_history jsonb not null default '[]'::jsonb,
      direction text,
      kpi jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  for (const f of [
    "0317_project_tracks_live_name_unique.sql",
    "0344_track_lifecycle_and_verdict.sql",
    "0345_track_goal_content.sql",
    "0348_track_participants.sql",
    "0349_track_verdict_retired.sql",
    "0350_track_goal_loop.sql",
  ]) {
    await h.client!.exec(migration(f));
  }
  // The edge-uniqueness index `createLinks` conflicts on.
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, $2, 'Ana', 'human'), ($3, $4, 'Claude', 'agent')`,
    [USER, `${USER}@example.test`, AGENT, `${AGENT}@example.test`]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Builder', $2, '{}'::jsonb)`,
    [WS, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, USER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values
      ($1, $2, null, 'Newsletter', 'active'), ($3, $2, null, 'Other', 'active')`,
    [PROJECT, USER, OTHER_PROJECT]
  );
  for (const [slug, name] of [
    ["okr", "OKR"],
    ["goal", "Goal"],
    ["objective", "Objective"],
    ["task", "Task"],
  ]) {
    const id = randomUUID();
    profileIds.set(slug, id);
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, $2, $3, 'kind', 'workspace')`,
      [id, slug, name]
    );
  }
  registerTrackExecutors();
}, 180_000);

beforeEach(() => {
  h.permCalls.length = 0;
});

describe("convertEntityToGoal — an OKR", () => {
  it("maps title, notes and three key results onto a goal, links it, and leaves the entity as it was", async () => {
    const id = await entity("okr", "Grow the newsletter", OKR);
    const before = await entityRow(id);
    const res = await convertEntityToGoal({ entityId: id, actor: human });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.status).toBe("started");
    expect(res.track).toMatchObject({
      projectId: PROJECT,
      name: "Grow the newsletter",
      status: "active",
      endState: "Make the newsletter a lead engine.",
    });
    const view = await loadTrackView(res.track, human);
    expect(
      view.criteria.map((c) => ({
        key: c.key,
        statement: c.statement,
        checkKind: c.checkKind,
        check: c.check,
      }))
    ).toEqual([
      {
        key: "kr1",
        statement: "Qualified leads: target 40 per month",
        checkKind: "measured",
        check: {
          kind: "evidence",
          evidenceKey: "kr1",
          hint: "Was 12 per month when it became a goal",
        },
      },
      {
        key: "kr2",
        statement: "Open rate: target 45%",
        checkKind: "measured",
        check: { kind: "evidence", evidenceKey: "kr2" },
      },
      {
        key: "kr3",
        statement: "Paying subscribers: target 200",
        checkKind: "measured",
        check: { kind: "evidence", evidenceKey: "kr3" },
      },
    ]);
    // The entity's owner owns the goal.
    expect(view.participants).toMatchObject([
      { role: "owner", principalId: USER, displayName: "Ana" },
    ]);
    expect(await promotedTo(id)).toEqual([
      { to_id: res.track.id, workspace_id: WS },
    ]);
    expect(res.notCarried).toEqual(["okr-confidence", "okr-quarter"]);
    expect(await entityRow(id)).toEqual(before);
  });

  it("F9 — a lineage write that fails undoes the birth; the retry makes ONE goal, linked", async () => {
    const id = await entity("okr", "Born whole", OKR);
    // A real failure at the seam: the database refuses the lineage edge.
    await h.client!.exec(`
      create or replace function refuse_promoted_to() returns trigger as $$
      begin
        if new.link_type = 'promoted_to' then raise exception 'lineage refused'; end if;
        return new;
      end $$ language plpgsql;
      create trigger refuse_promoted_to before insert on links
        for each row execute function refuse_promoted_to();
    `);
    await expect(
      convertEntityToGoal({ entityId: id, actor: human })
    ).rejects.toThrow(/lineage refused/);
    const goalsNamed = async () =>
      (
        await q<{ id: string }>(
          `select id from project_tracks where name = 'Born whole'`
        )
      ).rows;
    // Nothing half-made: no goal holds the name, no owner row is left.
    expect(await goalsNamed()).toEqual([]);
    expect(
      (
        await q(
          `select 1 from track_participants tp left join project_tracks t on t.id = tp.track_id where t.id is null`
        )
      ).rows
    ).toEqual([]);

    await h.client!.exec(`drop trigger refuse_promoted_to on links`);
    const res = await convertEntityToGoal({ entityId: id, actor: human });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.status).toBe("started");
    expect((await goalsNamed()).map((r) => r.id)).toEqual([res.track.id]);
    expect(await promotedTo(id)).toEqual([
      { to_id: res.track.id, workspace_id: WS },
    ]);
  });

  it("refuses a second conversion — the edge says it is already a goal", async () => {
    const id = await entity("okr", "Only once", OKR);
    await convertEntityToGoal({ entityId: id, actor: human });
    await expect(
      convertEntityToGoal({ entityId: id, name: "Again", actor: human })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await promotedTo(id)).toHaveLength(1);
  });

  it("ONE key result rides the end state: a lasting goal, no criteria", async () => {
    const id = await entity("okr", "One result", {
      "okr-notes": "Ship it.",
      "kr1-label": "Signups",
      "kr1-target": 10,
    });
    const res = await convertEntityToGoal({ entityId: id, actor: human });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.track.endState).toBe(
      "Ship it.\nKey result:\n- Signups: target 10"
    );
    expect(res.track.criteria ?? []).toEqual([]);
  });

  it("a Completed OKR is born closed as met by the person, its key results in the end state", async () => {
    const id = await entity("okr", "Done already", {
      ...OKR,
      "okr-status": "Completed",
    });
    const res = await convertEntityToGoal({ entityId: id, actor: human });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.track).toMatchObject({
      status: "completed",
      verdict: "met",
      verdictBy: USER,
    });
    expect(res.track.endState).toContain(
      "Key results:\n- Qualified leads: target 40 per month\n- Open rate: target 45%\n- Paying subscribers: target 200"
    );
    expect(await promotedTo(id)).toHaveLength(1);
  });
});

describe("convertEntityToGoal — goal and objective", () => {
  it("an achieved Life OS goal: description and target date in the end state, closed met", async () => {
    const id = await entity("goal", "Run a marathon", {
      description: "Finish under four hours.",
      status: "achieved",
      "target-date": "2026-12-31T00:00:00.000Z",
      progress: 100,
      area: "Health",
    });
    const res = await convertEntityToGoal({ entityId: id, actor: human });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.track).toMatchObject({
      name: "Run a marathon",
      endState: "Finish under four hours. — by 2026-12-31",
      status: "completed",
      verdict: "met",
    });
    expect(res.notCarried).toEqual(["area", "progress"]);
  });

  it("an abandoned goal is born dropped — no longer needed", async () => {
    const id = await entity("goal", "Learn the oboe", { status: "abandoned" });
    const res = await convertEntityToGoal({ entityId: id, actor: human });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.track).toMatchObject({
      status: "archived",
      verdict: "no_longer_needed",
    });
  });

  it("an objective in a done lifecycle category closes met; its outcome is the end state", async () => {
    const id = await entity(
      "objective",
      "Enter Germany",
      { outcome: "Ten paying German clients.", targetDate: "2027-03-31" },
      { statusCategory: "done" }
    );
    const res = await convertEntityToGoal({ entityId: id, actor: human });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.track).toMatchObject({
      endState: "Ten paying German clients. — by 2027-03-31",
      status: "completed",
      verdict: "met",
    });
  });
});

describe("convertEntityToGoal — refusals", () => {
  it("another kind is not a goal", async () => {
    const id = await entity("task", "Write the brief", {});
    await expect(
      convertEntityToGoal({ entityId: id, actor: human })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await promotedTo(id)).toHaveLength(0);
  });

  it("an entity filed in no project asks for one; with projectId it converts there", async () => {
    const id = await entity("goal", "Unfiled", {}, { projects: [] });
    await expect(
      convertEntityToGoal({ entityId: id, actor: human })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("filed in no project"),
    });
    const res = await convertEntityToGoal({
      entityId: id,
      projectId: OTHER_PROJECT,
      actor: human,
    });
    if (res.status === "proposed") throw new Error("unexpected proposal");
    expect(res.track.projectId).toBe(OTHER_PROJECT);
  });

  it("an entity filed in two projects asks which one", async () => {
    const id = await entity(
      "goal",
      "Two homes",
      {},
      { projects: [PROJECT, OTHER_PROJECT] }
    );
    await expect(
      convertEntityToGoal({ entityId: id, actor: human })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("several projects"),
    });
  });
});

describe("an agent's conversion — one governed proposal", () => {
  it("an ended entity is FORCED to a proposal and writes nothing; the replay creates, links and closes as the approver", async () => {
    const id = await entity("objective", "Agent found it done", {
      outcome: "Shipped.",
      status: "achieved",
    });
    const res = await convertEntityToGoal({ entityId: id, actor: agent });
    expect(res.status).toBe("proposed");
    expect(h.permCalls).toHaveLength(1);
    const call = h.permCalls[0]!;
    expect(call).toMatchObject({
      subjectType: "track",
      action: "create",
      agentUserId: AGENT,
      forcePropose: true,
      data: expect.objectContaining({
        name: "Agent found it done",
        fromEntity: {
          entityId: id,
          kind: "objective",
          title: "Agent found it done",
          ended: { status: "completed", verdict: "met" },
        },
      }),
    });
    expect(await promotedTo(id)).toHaveLength(0);

    const proposalId = randomUUID();
    await proposalExecRegistry.resolveExact("track/create")!.execute({
      proposal: {
        id: proposalId,
        targetType: "track",
        targetId: null,
        proposalType: "create",
        workspaceId: null,
        agentUserId: AGENT,
        subjectUserId: null,
        sourceMessageId: null,
        data: { data: call.data },
      },
      userId: USER,
      input: { proposalId },
      deps: {
        reportProposalOutcome: () => {},
        emitProposalReviewed: () => {},
      },
    } as unknown as ProposalExecutorArgs);
    const [edge] = await promotedTo(id);
    expect(edge).toBeDefined();
    const track = await getTrack(edge!.to_id, human);
    expect(track).toMatchObject({
      name: "Agent found it done",
      status: "completed",
      verdict: "met",
      verdictBy: USER,
    });
  });

  it("an agent's conversion of a live entity is a plain start proposal (not forced) carrying fromEntity", async () => {
    const id = await entity("okr", "Agent live OKR", OKR);
    const res = await convertEntityToGoal({ entityId: id, actor: agent });
    expect(res.status).toBe("proposed");
    expect(h.permCalls[0]).not.toHaveProperty("forcePropose");
    expect(h.permCalls[0]!.data).toMatchObject({
      fromEntity: { entityId: id, ended: null },
    });
  });
});
