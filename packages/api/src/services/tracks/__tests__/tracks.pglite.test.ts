/**
 * TRACKS on PGlite — the REAL service (`startTrack`, `advanceTrackStage`,
 * `setTrackStatus`, `listTracks`, `getTrack`), the REAL access registry
 * (`project_tracks` VisibilityRule → the project predicate), the REAL gate core
 * (`applyStageGate` + the track adapter), the REAL `track/*` executors and the
 * REAL `getProjectPath`. Tables are generated from the Drizzle definitions.
 *
 * Stubbed, and only at the seams that need infrastructure this suite has not:
 *   · `checkPermissionOrPropose` — a stand-in for the governance ladder that
 *     PROPOSES for an agent and GRANTS for a human (the ladder itself is
 *     covered by its own suites); the call's payload is what is asserted.
 *   · `createEventBackedProposal` — the stage-gate proposal insert (captured).
 *   · `createLinks`, `emitSideEffects`, the EventRepository append — captured.
 *
 * NOT covered here: a workspace-scoped project's MEMBERSHIP floor (the
 * registry predicate is the projects predicate, shared by construction — see
 * `access/project-visibility.ts`); a track `check` gate's measurement (it is
 * fail-closed by design and asserted as such below).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
  gateProposals: [] as Array<Record<string, unknown>>,
  links: [] as unknown[],
  emits: [] as Array<Record<string, unknown>>,
  events: [] as Array<{ type: string }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      projectTracks: actual.projectTracks as never,
      playbooks: actual.playbooks as never,
      projects: actual.projects as never,
    },
  });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    EventRepository: class {
      async append(e: { type: string }) {
        h.events.push(e);
      }
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

vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: Record<string, unknown>) => {
    h.gateProposals.push(input);
    return { proposal: { id: randomUUID(), status: "pending" } };
  },
}));

vi.mock("../../links/links-service.js", () => ({
  createLinks: async (edges: unknown[]) => {
    h.links.push(...edges);
    return [];
  },
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: async (p: Record<string, unknown>) => {
    h.emits.push(p);
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  playbooks,
  projects,
  proposals,
  workspaces,
  workspaceMembers,
  users,
  chatTurns,
  artifacts,
  links,
  entities,
  documents,
  views,
  automations,
} from "@synap/database";
import {
  advanceTrackStage,
  getTrack,
  listTracks,
  setTrackStatus,
  startTrack,
  countProjectsUsingMethods,
  applyTrackStageAdvance,
  toTrackView,
} from "../tracks-service.js";
import { getProjectPath } from "../../projects/project-path.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerTrackExecutors } from "../../../routers/proposals/executors/track.js";
import type { ProposalExecutorArgs } from "../../../routers/proposals/execution-registry.js";

const USER = "user-1";
const STRANGER = "user-2";
const AGENT = "agent-1";
const PROJECT = randomUUID();
const OTHER_PROJECT = randomUUID();
const STRANGERS_PROJECT = randomUUID();
const STALE_PROJECT = randomUUID();
const METHOD = randomUUID();
const GATED_METHOD = randomUUID();
const SESSION_PLAYBOOK = randomUUID();

const STAGES = [
  { key: "discover", name: "Discover", category: "planned" },
  { key: "build", name: "Build", category: "started" },
  { key: "ship", name: "Ship", category: "completed" },
];
const GATED_STAGES = [
  { key: "draft", name: "Draft", category: "planned" },
  {
    key: "review",
    name: "Review",
    category: "started",
    gate: { kind: "human" },
  },
  {
    key: "audit",
    name: "Audit",
    category: "completed",
    gate: { kind: "check" },
  },
];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.hasDefault && c.name === "id" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const human = { userId: USER };
const agent = { userId: USER, agentUserId: AGENT, isHubProtocol: true };

async function trackRows(projectId = PROJECT) {
  return (
    await q<{ id: string; status: string; current_stage: string | null }>(
      `select id, status, current_stage from project_tracks where project_id = $1 order by created_at`,
      [projectId]
    )
  ).rows;
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    chatTurns,
    workspaces,
    workspaceMembers,
    artifacts,
    links,
    entities,
    documents,
    views,
    automations,
    playbooks,
    projects,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  // The REAL table shape for tracks — defaults, the status CHECK and the
  // live-method unique index are what idempotency rides on.
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
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index uniq_project_tracks_live_method
      on project_tracks (project_id, playbook_id)
      where status <> 'archived' and playbook_id is not null;
    create schema pgboss;
    create table pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);
  `);

  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values
      ($1, $2, null, 'Launch', 'active'),
      ($3, $2, null, 'Other', 'active'),
      ($4, $5, null, 'Theirs', 'active'),
      ($6, $2, null, 'Stale', 'active')`,
    [PROJECT, USER, OTHER_PROJECT, STRANGERS_PROJECT, STRANGER, STALE_PROJECT]
  );
  for (const [id, name, scope, stages] of [
    [METHOD, "Business model", "project", STAGES],
    [GATED_METHOD, "Content", "project", GATED_STAGES],
    [SESSION_PLAYBOOK, "Weekly review", "session", STAGES],
  ] as const) {
    await q(
      `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, version, executor, status, scope, metadata, created_at, updated_at)
       values ($1, null, $2, $3, 'Do it', '[]', '{"kind":"none"}', '{}', '[]', $4::jsonb, '[]', 2, 'is-agent', 'active', $5, '{}', now(), now())`,
      [id, USER, name, JSON.stringify(stages), scope]
    );
  }
  registerTrackExecutors();
});

beforeEach(() => {
  h.permCalls.length = 0;
  h.gateProposals.length = 0;
  h.emits.length = 0;
  h.events.length = 0;
  h.links.length = 0;
});

describe("startTrack", () => {
  it("REFUSES a session-scoped playbook — it is not a method", async () => {
    await expect(
      startTrack({
        projectId: PROJECT,
        playbookId: SESSION_PLAYBOOK,
        actor: human,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await trackRows()).toHaveLength(0);
  });

  it("starts a method: pins the snapshot + version, seeds the first stage, writes the lineage edge", async () => {
    const result = await startTrack({
      projectId: PROJECT,
      playbookId: METHOD,
      actor: human,
    });
    expect(result.status).toBe("started");
    if (result.status === "proposed") throw new Error("unreachable");
    expect(result.track).toMatchObject({
      projectId: PROJECT,
      playbookId: METHOD,
      name: "Business model",
      methodVersion: "2",
      currentStage: "discover",
      status: "active",
    });
    expect(
      (result.track.definitionSnapshot.stages as Array<{ key: string }>).map(
        (s) => s.key
      )
    ).toEqual(["discover", "build", "ship"]);
    expect(h.links).toContainEqual(
      expect.objectContaining({
        fromType: "project",
        fromId: PROJECT,
        toType: "playbook",
        toId: METHOD,
        linkType: "instantiated_from",
      })
    );
    expect(h.events.map((e) => e.type)).toContain("track.create.completed");
    expect(h.emits).toContainEqual(
      expect.objectContaining({ subjectType: "track", action: "create" })
    );
  });

  it("is IDEMPOTENT: the same method twice on one project is one track", async () => {
    const again = await startTrack({
      projectId: PROJECT,
      playbookId: METHOD,
      actor: human,
    });
    expect(again.status).toBe("exists");
    expect(await trackRows()).toHaveLength(1);
    expect(h.permCalls).toHaveLength(0);
    expect(h.links).toHaveLength(0);
  });

  it("an AGENT start is PROPOSED with the full payload and writes nothing; the executor replays it through the same service", async () => {
    const result = await startTrack({
      projectId: PROJECT,
      playbookId: GATED_METHOD,
      name: "Content engine",
      actor: agent,
    });
    expect(result.status).toBe("proposed");
    expect(h.permCalls).toHaveLength(1);
    const call = h.permCalls[0]!;
    expect(call).toMatchObject({
      subjectType: "track",
      action: "create",
      agentUserId: AGENT,
      projectId: PROJECT,
    });
    const data = call.data as Record<string, unknown>;
    expect(data).toMatchObject({
      projectId: PROJECT,
      playbookId: GATED_METHOD,
      name: "Content engine",
    });
    expect(typeof data.id).toBe("string");
    expect(await trackRows()).toHaveLength(1); // only the human's

    // APPROVAL — the registered `track/create` executor replays via startTrack.
    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data) values ($1, 'pending', 'track', $2, 'create', $3::jsonb)`,
      [proposalId, data.id, JSON.stringify({ data })]
    );
    const executor = proposalExecRegistry.resolveExact("track/create");
    expect(executor).toBeTruthy();
    const out = await executor!.execute({
      proposal: {
        id: proposalId,
        targetType: "track",
        targetId: data.id,
        proposalType: "create",
        workspaceId: null,
        sessionId: null,
        projectId: PROJECT,
        agentUserId: AGENT,
        sourceMessageId: null,
        data: { data },
      },
      payload: null,
      userId: USER,
      input: { proposalId },
      ctx: {},
      deps: {
        reportProposalOutcome: () => {},
        emitProposalReviewed: () => {},
      },
    } as unknown as ProposalExecutorArgs);
    expect(out).toMatchObject({ success: true });
    const rows = await trackRows();
    expect(rows).toHaveLength(2);
    // The row lands at the id the proposal was filed under.
    expect(rows.map((r) => r.id)).toContain(data.id);
    const [status] = (
      await q<{ status: string }>(
        `select status from proposals where id = $1`,
        [proposalId]
      )
    ).rows;
    expect(status!.status).toBe("approved");
  });
});

describe("visibility — a track is exactly as visible as its project", () => {
  it("a caller who cannot see the project sees neither the list nor the track", async () => {
    const [row] = await trackRows();
    expect(await getTrack(row!.id, { userId: STRANGER })).toBeNull();
    expect(
      await listTracks({ projectId: PROJECT, actor: { userId: STRANGER } })
    ).toBeNull();
    // …while the owner does.
    expect(await getTrack(row!.id, human)).not.toBeNull();
    expect(
      (await listTracks({ projectId: PROJECT, actor: human }))!.length
    ).toBe(2);
  });

  it("a stranger cannot start a method on a project they cannot see", async () => {
    await expect(
      startTrack({
        projectId: PROJECT,
        playbookId: METHOD,
        actor: { userId: STRANGER },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("counts projects using a method over VISIBLE projects, in one grouped read", async () => {
    await startTrack({
      projectId: OTHER_PROJECT,
      playbookId: METHOD,
      actor: human,
    });
    const usage = await countProjectsUsingMethods(
      [METHOD, GATED_METHOD, SESSION_PLAYBOOK],
      human
    );
    expect(usage.get(METHOD)).toBe(2);
    expect(usage.get(GATED_METHOD)).toBe(1);
    expect(usage.has(SESSION_PLAYBOOK)).toBe(false);
    // The stranger sees none of these projects, so none of the usage.
    expect(
      (await countProjectsUsingMethods([METHOD], { userId: STRANGER })).size
    ).toBe(0);
  });
});

describe("advanceTrackStage — through the SHARED gate core", () => {
  async function gatedTrackId() {
    const rows = (
      await q<{ id: string }>(
        `select id from project_tracks where project_id = $1 and playbook_id = $2`,
        [PROJECT, GATED_METHOD]
      )
    ).rows;
    return rows[0]!.id;
  }

  it("refuses a stage the pinned method does not declare", async () => {
    await expect(
      advanceTrackStage({
        trackId: await gatedTrackId(),
        toStage: "nope",
        actor: human,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("entering a HUMAN-gated stage: the stage stands, the track pauses, ONE proposal targets the track", async () => {
    const trackId = await gatedTrackId();
    const result = await advanceTrackStage({
      trackId,
      toStage: "review",
      actor: human,
    });
    expect(result).toMatchObject({
      status: "advanced",
      gated: true,
      paused: true,
    });
    // S1: the RETURNED track is the post-gate state — never `paused: true`
    // beside `status: "active"`.
    if (result.status === "proposed") throw new Error("unexpected proposal");
    expect(result.track.status).toBe("paused");
    expect(toTrackView(result.track).pausedBy).toBe("human");
    // S3: the gate's pause went through the repository — its fact fired
    // (one for the stage write, one for the pause).
    expect(
      h.events.filter((e) => e.type === "track.update.completed")
    ).toHaveLength(2);
    const [row] = (
      await q<{ status: string; current_stage: string }>(
        `select status, current_stage from project_tracks where id = $1`,
        [trackId]
      )
    ).rows;
    expect(row).toEqual({ status: "paused", current_stage: "review" });
    expect(h.gateProposals).toHaveLength(1);
    expect(h.gateProposals[0]).toMatchObject({
      targetType: "track",
      targetId: trackId,
      action: "stage_gate",
      proposalType: "playbook.stage_gate",
      sessionId: null,
      projectId: PROJECT,
    });
    expect((h.gateProposals[0]!.data as Record<string, unknown>).trackId).toBe(
      trackId
    );
    expect(h.emits).toContainEqual(
      expect.objectContaining({
        subjectType: "track",
        action: "stage_changed",
        data: expect.objectContaining({
          fromStage: "draft",
          toStage: "review",
        }),
      })
    );

    // Approving the gate RESUMES the track (and never moves the stage).
    const gate = proposalExecRegistry.resolveExact("track/playbook.stage_gate");
    const proposalId = randomUUID();
    await q(`insert into proposals (id, status) values ($1, 'pending')`, [
      proposalId,
    ]);
    const out = await gate!.execute({
      proposal: {
        id: proposalId,
        targetType: "track",
        targetId: trackId,
        proposalType: "playbook.stage_gate",
        workspaceId: null,
        data: {},
      },
      userId: USER,
      input: { proposalId },
      deps: {
        reportProposalOutcome: () => {},
        emitProposalReviewed: () => {},
      },
    } as unknown as ProposalExecutorArgs);
    expect(out).toMatchObject({ effect: { applied: "verified" } });
    // S3: the resume emits its fact too.
    expect(
      h.events.filter((e) => e.type === "track.update.completed")
    ).toHaveLength(3);
    expect((await getTrack(trackId, human))!.status).toBe("active");
    expect((await getTrack(trackId, human))!.currentStage).toBe("review");
  });

  it("a CHECK gate on a track holds it paused (fail-closed: a track has no criteria to measure)", async () => {
    const trackId = await gatedTrackId();
    const result = await advanceTrackStage({
      trackId,
      toStage: "audit",
      actor: human,
    });
    expect(result).toMatchObject({
      gated: true,
      paused: true,
      check: { passed: false },
    });
    expect(h.gateProposals).toHaveLength(0);
    const [row] = (
      await q<{ metadata: Record<string, unknown> }>(
        `select metadata from project_tracks where id = $1`,
        [trackId]
      )
    ).rows;
    expect(row!.metadata.checkGate).toMatchObject({
      stageKey: "audit",
      fromStage: "review",
    });
    if (result.status === "proposed") throw new Error("unexpected proposal");
    expect(result.track.status).toBe("paused");
    expect(toTrackView(result.track).pausedBy).toBe("check");

    // S2: RESUMING clears the marker — a resumed track is held by nothing.
    const resumed = await setTrackStatus({
      trackId,
      status: "active",
      actor: human,
    });
    if (resumed.status === "proposed") throw new Error("unexpected proposal");
    expect(toTrackView(resumed.track).pausedBy).toBeNull();
    const [after] = (
      await q<{ metadata: Record<string, unknown> }>(
        `select metadata from project_tracks where id = $1`,
        [trackId]
      )
    ).rows;
    expect(after!.metadata.checkGate).toBeUndefined();
  });

  it("stages are RE-ENTERABLE: an ungated move back lands and files nothing", async () => {
    const [bm] = (
      await q<{ id: string }>(
        `select id from project_tracks where project_id = $1 and playbook_id = $2`,
        [PROJECT, METHOD]
      )
    ).rows;
    await advanceTrackStage({ trackId: bm!.id, toStage: "ship", actor: human });
    const back = await advanceTrackStage({
      trackId: bm!.id,
      toStage: "discover",
      actor: human,
    });
    expect(back).toMatchObject({ status: "advanced", gated: false });
    expect(h.gateProposals).toHaveLength(0);
  });

  it("an AGENT advance is proposed (track/update) and moves nothing", async () => {
    const [bm] = (
      await q<{ id: string; current_stage: string }>(
        `select id, current_stage from project_tracks where project_id = $1 and playbook_id = $2`,
        [PROJECT, METHOD]
      )
    ).rows;
    const result = await advanceTrackStage({
      trackId: bm!.id,
      toStage: "build",
      actor: agent,
    });
    expect(result.status).toBe("proposed");
    expect(h.permCalls.at(-1)).toMatchObject({
      subjectType: "track",
      action: "update",
      data: { id: bm!.id, currentStage: "build" },
    });
    expect((await getTrack(bm!.id, human))!.currentStage).toBe(
      bm!.current_stage
    );
  });

  it("archived is FINAL — a status move out of it is refused", async () => {
    const [bm] = (
      await q<{ id: string }>(
        `select id from project_tracks where project_id = $1`,
        [OTHER_PROJECT]
      )
    ).rows;
    await setTrackStatus({ trackId: bm!.id, status: "archived", actor: human });
    await expect(
      setTrackStatus({ trackId: bm!.id, status: "active", actor: human })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("stale writes — the approval replay and a concurrent advance", () => {
  it("MUST-1: a status proposal approved AFTER the track was archived is REFUSED, not replayed", async () => {
    const started = await startTrack({
      projectId: STALE_PROJECT,
      playbookId: METHOD,
      actor: human,
    });
    if (started.status === "proposed") throw new Error("unexpected proposal");
    const trackId = started.track.id;

    // An agent files "pause it" while that is legal…
    const filed = await setTrackStatus({
      trackId,
      status: "paused",
      actor: agent,
    });
    expect(filed.status).toBe("proposed");
    const data = h.permCalls.at(-1)!.data as Record<string, unknown>;
    expect(data).toMatchObject({ id: trackId, status: "paused" });

    // …then a person archives the track before anyone reviews it.
    await setTrackStatus({ trackId, status: "archived", actor: human });

    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data) values ($1, 'pending', 'track', $2, 'update', $3::jsonb)`,
      [proposalId, trackId, JSON.stringify({ data })]
    );
    const executor = proposalExecRegistry.resolveExact("track/update");
    await expect(
      executor!.execute({
        proposal: {
          id: proposalId,
          targetType: "track",
          targetId: trackId,
          proposalType: "update",
          workspaceId: null,
          data: { data },
        },
        userId: USER,
        input: { proposalId },
        deps: {
          reportProposalOutcome: () => {},
          emitProposalReviewed: () => {},
        },
      } as unknown as ProposalExecutorArgs)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await getTrack(trackId, human))!.status).toBe("archived");
    const [p] = (
      await q<{ status: string }>(
        `select status from proposals where id = $1`,
        [proposalId]
      )
    ).rows;
    expect(p!.status).toBe("pending");
  });

  it("S4: a stage advance decided on a stale stage is a CONFLICT, and moves nothing", async () => {
    const started = await startTrack({
      projectId: STALE_PROJECT,
      playbookId: GATED_METHOD,
      actor: human,
    });
    if (started.status === "proposed") throw new Error("unexpected proposal");
    const stale = started.track; // stands on "draft"
    await advanceTrackStage({
      trackId: stale.id,
      toStage: "audit",
      actor: human,
    });
    // `stale` still says "draft"; the row stands on "audit".
    await expect(
      applyTrackStageAdvance({
        track: stale,
        project: { id: STALE_PROJECT, workspaceId: null, userId: USER },
        toStage: "review",
        userId: USER,
        gate: false,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getTrack(stale.id, human))!.currentStage).toBe("audit");
  });
});

describe("Project Path — sessions born inside a track", () => {
  const TRACKED_RUN = randomUUID();
  const UNTRACKED_RUN = randomUUID();
  const WORK = randomUUID();

  beforeAll(async () => {
    const [bm] = (
      await q<{ id: string }>(
        `select id from project_tracks where project_id = $1 and playbook_id = $2`,
        [PROJECT, METHOD]
      )
    ).rows;
    const insert = (
      id: string,
      goal: string,
      origin: string,
      playbookId: string | null,
      trackId: string | null
    ) =>
      q(
        `insert into focus_sessions (id, user_id, workspace_id, project_id, track_id, playbook_id, goal, status, expected_outputs, metadata, origin, created_at, updated_at, started_at)
         values ($1, $2, null, $3, $4, $5, $6, 'active', '[]'::jsonb, '{}'::jsonb, $7, now(), now(), now())`,
        [id, USER, PROJECT, trackId, playbookId, goal, origin]
      );
    await insert(TRACKED_RUN, "Model the pricing", "playbook", METHOD, bm!.id);
    await insert(UNTRACKED_RUN, "Nightly sync", "playbook", METHOD, null);
    await insert(WORK, "Write the brief", "human", null, null);
  });

  it("lists a RUN-kind session that carries a track, and not one that does not", async () => {
    const result = await getProjectPath({
      userId: USER,
      projectId: PROJECT,
      lens: "default",
      limit: 50,
      offset: 0,
    });
    const ids = result!.items.map((r) => r.id);
    expect(ids).toContain(WORK);
    expect(ids).toContain(TRACKED_RUN);
    expect(ids).not.toContain(UNTRACKED_RUN);
    const tracked = result!.items.find((r) => r.id === TRACKED_RUN)!;
    // The kind is NOT rewritten — only the path's population widened.
    expect(tracked.kind).toBe("run");
    expect(tracked.trackId).not.toBeNull();
    expect(result!.items.find((r) => r.id === WORK)!.trackId).toBeNull();
  });

  it("returns the project's tracks with their pinned stages", async () => {
    const result = await getProjectPath({
      userId: USER,
      projectId: PROJECT,
      lens: "default",
      limit: 50,
      offset: 0,
    });
    expect(result!.tracks.status).toBe("ok");
    if (result!.tracks.status !== "ok") return;
    const names = result!.tracks.items.map((t) => t.name).sort();
    expect(names).toEqual(["Business model", "Content engine"]);
    const bm = result!.tracks.items.find((t) => t.name === "Business model")!;
    expect(bm.stages.map((s) => s.key)).toEqual(["discover", "build", "ship"]);
    expect(bm.stages.find((s) => s.key === bm.currentStage)!.position).toBe(
      "active"
    );
  });
});
