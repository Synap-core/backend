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
 * `access/project-visibility.ts`); a track `check` gate's measurement over
 * filed sessions (`track-stages.pglite.test.ts` — here only the empty-stage
 * hold is asserted).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const M0317 = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../database/migrations/0317_project_tracks_live_name_unique.sql",
      import.meta.url
    )
  ),
  "utf8"
);
// The track lifecycle (open statuses, verdict columns + CHECK, the live-name
// index for the new live set) — the REAL migration, on top of 0317.
const M0344 = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../database/migrations/0344_track_lifecycle_and_verdict.sql",
      import.meta.url
    )
  ),
  "utf8"
);

// What a goal holds (end state, criteria, drop conditions, kind, uncertainty)
// — the REAL migration, on top of 0344.
const M0345 = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../database/migrations/0345_track_goal_content.sql",
      import.meta.url
    )
  ),
  "utf8"
);
// An operation ends retired (R6) — the verdict CHECK admits `retired`.
const M0347 = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../database/migrations/0347_track_verdict_retired.sql",
      import.meta.url
    )
  ),
  "utf8"
);

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
  podMembers,
  projectMembers,
  sessionEvaluations,
  trackParticipants,
} from "@synap/database";
import {
  advanceTrackStage,
  getTrack,
  listTracks,
  setTrackStatus,
  startTrack,
  reopenTrack,
  resolveTrackFiling,
  countProjectsUsingMethods,
  applyTrackStageAdvance,
  toTrackView,
  setTrackDirection,
  acceptGoalCriterion,
  loadTrackViews,
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
    podMembers,
    projectMembers,
    sessionEvaluations,
    // Who is on a goal (0346): `startTrack` seeds the owner row.
    trackParticipants,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  // A KNOWN principal (Sites W2 S2): an id with no `users` row is an unknown
  // principal and reads no pod-level row (pod-wide globals, pod-visible
  // workspaces) — `podReaderWhere`. This fixture models provisioned users.
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test'), ('${STRANGER}', '${STRANGER}@example.test')`
  );
  // The REAL table shape for tracks — defaults, the status CHECK and the
  // live-name unique index (0317, below) are what idempotency rides on.
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
    create schema pgboss;
    create table pgboss.job (id uuid primary key default gen_random_uuid(), name text, state text, data jsonb);
  `);
  // The live-name unique index idempotency rides on — the REAL migrations.
  await h.client!.exec(M0317);
  await h.client!.exec(M0344);
  await h.client!.exec(M0345);
  await h.client!.exec(M0347);
  // The edge-uniqueness index the dependency door's insert conflicts on
  // (`idx_links_unique_edge`) — a reopen writes `new --replaces--> old`.
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type)`
  );

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

describe("synap_start_track — the caller's session reaches the gate", () => {
  // The MCP handler module graph is large: importing it inside the test body
  // counted its load time against the test timeout and timed out under load.
  let trackHandlers: (typeof import("../../../routers/mcp/handlers/track.js"))["trackHandlers"];
  beforeAll(async () => {
    ({ trackHandlers } =
      await import("../../../routers/mcp/handlers/track.js"));
  }, 180_000);

  it("the MCP door hands its resolved sessionId to the gate, so the proposal is filed under it", async () => {
    const SESSION = randomUUID();
    const res = await trackHandlers.synap_start_track!({
      toolName: "synap_start_track",
      args: { projectId: PROJECT, name: "Filed under a session" },
      userId: USER,
      apiKeyScopes: ["mcp.write"],
      agentUserId: AGENT,
      sessionId: SESSION,
      caller: undefined as never,
      lensCaller: undefined as never,
      workspaceAccessible: false,
    });
    expect(JSON.stringify(res)).toContain("proposed");
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "track",
      action: "create",
      agentUserId: AGENT,
      sessionId: SESSION,
    });
  });

  it("synap_reopen_track: the agent's reopen goes through the start door as a proposal naming the version it replaces", async () => {
    // Its own project: the suites below count PROJECT's tracks.
    const REOPEN_MCP = randomUUID();
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Reopen MCP', 'active')`,
      [REOPEN_MCP, USER]
    );
    const started = await startTrack({
      projectId: REOPEN_MCP,
      name: "Reopened over MCP",
      actor: human,
    });
    if (started.status === "proposed") throw new Error("unreachable");
    await setTrackStatus({
      trackId: started.track.id,
      status: "completed",
      verdict: "met",
      actor: human,
    });
    h.permCalls.length = 0;
    const ctx = {
      toolName: "synap_reopen_track",
      userId: USER,
      apiKeyScopes: ["mcp.write"],
      agentUserId: AGENT,
      caller: undefined as never,
      lensCaller: undefined as never,
      workspaceAccessible: false,
    };
    const bad = await trackHandlers.synap_reopen_track!({
      ...ctx,
      args: { trackId: "not-a-uuid" },
    });
    expect(JSON.stringify(bad)).toContain("trackId (uuid) is required");
    expect(h.permCalls).toHaveLength(0);

    const res = await trackHandlers.synap_reopen_track!({
      ...ctx,
      args: { trackId: started.track.id, reasoning: "The launch slipped" },
    });
    expect(JSON.stringify(res)).toContain("proposed");
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "track",
      action: "create",
      agentUserId: AGENT,
      source: "mcp",
      reasoning: "The launch slipped",
      data: expect.objectContaining({
        name: "Reopened over MCP",
        replacesTrackId: started.track.id,
      }),
    });
    // Nothing written: the closed track stays closed, no new version yet.
    expect((await getTrack(started.track.id, human))!.status).toBe("completed");
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

describe("startTrack with NO method — a stage-less track (W1)", () => {
  const LASTING = randomUUID();
  beforeAll(async () => {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Lasting', 'active')`,
      [LASTING, USER]
    );
  });

  it("a person starts a named track with no method: no stages, no lineage edge, the goal stored", async () => {
    const result = await startTrack({
      projectId: LASTING,
      name: "Grow the newsletter",
      direction: "A newsletter people forward",
      kpi: { label: "Subscribers", target: 1000 },
      actor: human,
    });
    if (result.status === "proposed") throw new Error("human start proposed");
    expect(result.status).toBe("started");
    expect(result.playbook).toBeNull();
    expect(result.missingDomains).toEqual([]);
    expect(result.track).toMatchObject({
      projectId: LASTING,
      playbookId: null,
      name: "Grow the newsletter",
      currentStage: null,
      status: "active",
      direction: "A newsletter people forward",
      kpi: expect.objectContaining({ label: "Subscribers", target: 1000 }),
      stageHistory: [],
    });
    expect(h.links).toEqual([]); // no method ⇒ no `instantiated_from` edge
    expect(h.emits).toContainEqual(
      expect.objectContaining({ subjectType: "track", action: "create" })
    );
  });

  it("is idempotent per name, and a method's track holding the name is a CONFLICT", async () => {
    const again = await startTrack({
      projectId: LASTING,
      name: "grow the newsletter ",
      actor: human,
    });
    expect(again.status).toBe("exists");
    await startTrack({
      projectId: LASTING,
      playbookId: METHOD,
      actor: human,
    });
    await expect(
      startTrack({ projectId: LASTING, name: "Business model", actor: human })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a method-less start with no name, or with params (nothing declares them)", async () => {
    await expect(
      startTrack({ projectId: LASTING, actor: human })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      startTrack({
        projectId: LASTING,
        name: "Hiring",
        params: { role: "x" },
        actor: human,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an AGENT start is proposed WITHOUT a method; approval replays it with its goal", async () => {
    const result = await startTrack({
      projectId: LASTING,
      name: "Community",
      direction: "People who help each other",
      kpi: { label: "Weekly posts", target: 20 },
      actor: agent,
    });
    expect(result.status).toBe("proposed");
    const data = h.permCalls.at(-1)!.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("playbookId");
    expect(data).toMatchObject({ projectId: LASTING, name: "Community" });

    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data) values ($1, 'pending', 'track', $2, 'create', $3::jsonb)`,
      [proposalId, data.id, JSON.stringify({ data })]
    );
    const out = await proposalExecRegistry
      .resolveExact("track/create")!
      .execute({
        proposal: {
          id: proposalId,
          targetType: "track",
          targetId: data.id,
          proposalType: "create",
          workspaceId: null,
          sessionId: null,
          projectId: LASTING,
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
    const track = await getTrack(String(data.id), human);
    expect(track).toMatchObject({
      playbookId: null,
      name: "Community",
      currentStage: null,
      // The goal the person approved survives the replay.
      direction: "People who help each other",
      kpi: expect.objectContaining({ label: "Weekly posts", target: 20 }),
    });
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

  it("a CHECK gate on a track holds it paused when no session was filed at the stage being left", async () => {
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
    await setTrackStatus({
      trackId: bm!.id,
      status: "archived",
      verdict: "no_longer_needed",
      actor: human,
    });
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

    // …then a person drops the track before anyone reviews it.
    await setTrackStatus({
      trackId,
      status: "archived",
      verdict: "no_longer_needed",
      actor: human,
    });

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

describe("a live track's identity is its NAME (0317) — a method can run twice", () => {
  const NAMED = randomUUID();
  const liveCount = async () =>
    (await trackRows(NAMED)).filter(
      (r) => r.status === "active" || r.status === "paused"
    ).length;

  beforeAll(async () => {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Named', 'active')`,
      [NAMED, USER]
    );
  });

  it("the same method twice with NO name is one track (the name defaults to the method's)", async () => {
    const first = await startTrack({
      projectId: NAMED,
      playbookId: METHOD,
      actor: human,
    });
    expect(first.status).toBe("started");
    const again = await startTrack({
      projectId: NAMED,
      playbookId: METHOD,
      name: "  business MODEL ", // case- and space-insensitive, like the index
      actor: human,
    });
    expect(again.status).toBe("exists");
    if (first.status === "proposed" || again.status === "proposed") {
      throw new Error("unreachable");
    }
    expect(again.track.id).toBe(first.track.id);
    expect(await liveCount()).toBe(1);
  });

  it("the same method under ANOTHER name starts a second live track", async () => {
    const second = await startTrack({
      projectId: NAMED,
      playbookId: METHOD,
      name: "Business model — EU",
      actor: human,
    });
    expect(second.status).toBe("started");
    expect(await liveCount()).toBe(2);
  });

  it("a CLOSED track holds no name: the same name starts anew", async () => {
    const [first] = await trackRows(NAMED);
    const done = await setTrackStatus({
      trackId: first!.id,
      status: "completed",
      verdict: "met",
      actor: human,
    });
    expect(done.status).toBe("updated");
    const rerun = await startTrack({
      projectId: NAMED,
      playbookId: METHOD,
      actor: human,
    });
    expect(rerun.status).toBe("started");
    if (rerun.status === "proposed") throw new Error("unreachable");
    expect(rerun.track.id).not.toBe(first!.id);
    expect(rerun.track.name).toBe("Business model");
    expect(await trackRows(NAMED)).toHaveLength(3);
    expect(await liveCount()).toBe(2);
  });

  it("a closed track never reopens IN PLACE; reopening while an unrelated live track holds its name is a CONFLICT", async () => {
    const [first] = await trackRows(NAMED);
    expect(first!.status).toBe("completed");
    // Inverted from the reopen-in-place rule: done is final for the status door.
    await expect(
      setTrackStatus({ trackId: first!.id, status: "active", actor: human })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // The new-version door refuses to hand back a live goal it did not make.
    await expect(
      reopenTrack({ trackId: first!.id, actor: human })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await trackRows(NAMED))[0]!.status).toBe("completed");
    expect(await trackRows(NAMED)).toHaveLength(3);
  });

  it("ANOTHER method under a name a live track holds is refused, never handed back as `exists`", async () => {
    await expect(
      startTrack({
        projectId: NAMED,
        playbookId: GATED_METHOD,
        name: "Business model",
        actor: human,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await trackRows(NAMED)).toHaveLength(3);
  });

  it("the migration renames pre-existing live name twins (oldest keeps it) and is re-runnable", async () => {
    const DUP = randomUUID();
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Dup', 'active')`,
      [DUP, USER]
    );
    // The world 0272 allowed: two live tracks of DIFFERENT methods, one name.
    await h.client!.exec(`drop index uniq_project_tracks_live_name`);
    await q(
      `insert into project_tracks (project_id, user_id, playbook_id, name, status, created_at) values
        ($1, $2, $3, 'Plan', 'active', now() - interval '2 days'),
        ($1, $2, $4, 'plan ', 'paused', now() - interval '1 day'),
        ($1, $2, $4, 'Plan', 'archived', now())`,
      [DUP, USER, METHOD, GATED_METHOD]
    );
    await h.client!.exec(M0317);
    await h.client!.exec(M0317);
    // …and the lifecycle migration on top, as a pod runs them, re-runnable.
    await h.client!.exec(M0344);
    await h.client!.exec(M0344);
    const names = (
      await q<{ name: string; status: string }>(
        `select name, status from project_tracks where project_id = $1 order by created_at`,
        [DUP]
      )
    ).rows;
    expect(names).toEqual([
      { name: "Plan", status: "active" },
      { name: "plan (2)", status: "paused" },
      { name: "Plan", status: "archived" },
    ]);
    await expect(
      q(
        `insert into project_tracks (project_id, user_id, name, status) values ($1, $2, 'PLAN', 'active')`,
        [DUP, USER]
      )
    ).rejects.toThrow(/uniq_project_tracks_live_name/);
    // A goal still being shaped holds its name too (0344's live set).
    await expect(
      q(
        `insert into project_tracks (project_id, user_id, name, status) values ($1, $2, 'plan', 'proposed')`,
        [DUP, USER]
      )
    ).rejects.toThrow(/uniq_project_tracks_live_name/);
  });
});

// ── D1 / R1 / R8 (work model, 2026-10-23): one lifecycle for goals ──────────

describe("closing a goal — the verdict rule and the person's act", () => {
  const GOALS = randomUUID();
  beforeAll(async () => {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Goals', 'active')`,
      [GOALS, USER]
    );
  });
  async function goal(name: string): Promise<string> {
    const res = await startTrack({ projectId: GOALS, name, actor: human });
    if (res.status === "proposed") throw new Error("unreachable");
    return res.track.id;
  }
  async function row(id: string) {
    return (
      await q<{
        status: string;
        verdict: string | null;
        verdict_reason: string | null;
        verdict_by: string | null;
      }>(
        `select status, verdict, verdict_reason, verdict_by from project_tracks where id = $1`,
        [id]
      )
    ).rows[0]!;
  }

  it("a close WITHOUT a verdict is refused before governance, and nothing moves", async () => {
    const id = await goal("No verdict");
    h.permCalls.length = 0;
    for (const actor of [human, agent]) {
      await expect(
        setTrackStatus({ trackId: id, status: "completed", actor })
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/needs a verdict/),
      });
    }
    // Refused before anything was filed for a person to approve.
    expect(h.permCalls).toHaveLength(0);
    expect((await row(id)).status).toBe("active");
  });

  it("a DONE close with a LOST verdict is refused; impossible needs its reason", async () => {
    const id = await goal("Wrong ending");
    await expect(
      setTrackStatus({
        trackId: id,
        status: "completed",
        verdict: "no_longer_needed",
        actor: human,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      setTrackStatus({
        trackId: id,
        status: "archived",
        verdict: "impossible",
        actor: human,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/verdictReason/),
    });
    expect(await row(id)).toMatchObject({ status: "active", verdict: null });
  });

  it("BACK-COMPAT: a DROP without a verdict lands (shipped clients), stamping nothing; an agent's is still proposed", async () => {
    const id = await goal("Old client drops");
    // The browser Archive menu, the released CLI and the IS send no verdict.
    const res = await setTrackStatus({
      trackId: id,
      status: "archived",
      actor: human,
    });
    expect(res.status).toBe("updated");
    // Reads exactly like a track dropped before 0344.
    expect(await row(id)).toMatchObject({
      status: "archived",
      verdict: null,
      verdict_reason: null,
      verdict_by: null,
    });
    const viaAgent = await goal("Agent drops, no verdict");
    const filed = await setTrackStatus({
      trackId: viaAgent,
      status: "archived",
      actor: agent,
    });
    expect(filed.status).toBe("proposed");
    expect(h.permCalls.at(-1)!.lifecycleMove).toEqual({
      intoTerminal: true,
      humanOnly: false,
    });
    expect(h.permCalls.at(-1)!.data).not.toHaveProperty("verdict");
  });

  it("a person's close lands with its verdict, reason and closer; the view projects them", async () => {
    const id = await goal("Closed well");
    const res = await setTrackStatus({
      trackId: id,
      status: "archived",
      verdict: "replaced",
      verdictReason: "  Folded into the Q4 launch goal ",
      actor: human,
    });
    expect(res.status).toBe("updated");
    expect(await row(id)).toMatchObject({
      status: "archived",
      verdict: "replaced",
      verdict_reason: "Folded into the Q4 launch goal",
      verdict_by: USER,
    });
    const view = toTrackView((await getTrack(id, human))!);
    expect(view).toMatchObject({
      verdict: "replaced",
      verdictReason: "Folded into the Q4 launch goal",
      verdictBy: USER,
      verdictAt: expect.any(String),
    });
  });

  it("an AGENT close reaches governance as a HUMAN-ONLY terminal move with its verdict; approval closes it as the approver", async () => {
    const id = await goal("Agent says done");
    const filed = await setTrackStatus({
      trackId: id,
      status: "completed",
      verdict: "met",
      actor: agent,
    });
    expect(filed.status).toBe("proposed");
    const call = h.permCalls.at(-1)!;
    // The SAME classification a kind's done move gets (`classifyLifecycleMove`):
    // the floors above every rule read exactly this.
    expect(call.lifecycleMove).toEqual({ intoTerminal: true, humanOnly: true });
    expect(call.data).toMatchObject({
      id,
      status: "completed",
      verdict: "met",
    });
    expect((await row(id)).status).toBe("active");

    const data = call.data as Record<string, unknown>;
    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data) values ($1, 'pending', 'track', $2, 'update', $3::jsonb)`,
      [proposalId, id, JSON.stringify({ data })]
    );
    await proposalExecRegistry.resolveExact("track/update")!.execute({
      proposal: {
        id: proposalId,
        targetType: "track",
        targetId: id,
        proposalType: "update",
        workspaceId: null,
        agentUserId: AGENT,
        data: { data },
      },
      userId: USER,
      input: { proposalId },
      deps: {
        reportProposalOutcome: () => {},
        emitProposalReviewed: () => {},
      },
    } as unknown as ProposalExecutorArgs);
    expect(await row(id)).toMatchObject({
      status: "completed",
      verdict: "met",
      verdict_by: USER,
    });
  });

  it("a drop is a terminal (lost) move, not human-only; a pause keeps today's classification", async () => {
    const id = await goal("Agent drops");
    await setTrackStatus({
      trackId: id,
      status: "archived",
      verdict: "mistake",
      actor: agent,
    });
    expect(h.permCalls.at(-1)!.lifecycleMove).toEqual({
      intoTerminal: true,
      humanOnly: false,
    });
    await setTrackStatus({ trackId: id, status: "paused", actor: agent });
    expect(h.permCalls.at(-1)!.lifecycleMove).toBeUndefined();
  });

  it("the open statuses are reachable by explicit moves, and a shaped goal takes work; a closed one does not", async () => {
    const id = await goal("Shaped first");
    for (const status of ["proposed", "agreed", "ready", "active"] as const) {
      expect(
        (await setTrackStatus({ trackId: id, status, actor: human })).status
      ).toBe("updated");
    }
    await setTrackStatus({ trackId: id, status: "agreed", actor: human });
    await expect(
      resolveTrackFiling({ trackId: id, actor: human })
    ).resolves.toMatchObject({ trackId: id, projectId: GOALS });
    await setTrackStatus({
      trackId: id,
      status: "completed",
      verdict: "met",
      actor: human,
    });
    await expect(
      resolveTrackFiling({ trackId: id, actor: human })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("reopenTrack — a closed goal comes back as a NEW version (R8)", () => {
  const REOPEN = randomUUID();
  beforeAll(async () => {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Reopen', 'active')`,
      [REOPEN, USER]
    );
  });
  async function replacesEdges(fromId: string) {
    return (
      await q<{ to_id: string }>(
        `select to_id from links where from_type = 'track' and from_id = $1 and to_type = 'track' and link_type = 'replaces'`,
        [fromId]
      )
    ).rows.map((r) => r.to_id);
  }

  it("creates a new active track, linked new --replaces--> old; the old one stays closed with its verdict", async () => {
    const started = await startTrack({
      projectId: REOPEN,
      name: "Grow the newsletter",
      direction: "Reach the people who already read us",
      kpi: { label: "Subscribers", target: 500, current: 510 },
      actor: human,
    });
    if (started.status === "proposed") throw new Error("unreachable");
    const oldId = started.track.id;
    await setTrackStatus({
      trackId: oldId,
      status: "completed",
      verdict: "met",
      actor: human,
    });

    const reopened = await reopenTrack({ trackId: oldId, actor: human });
    expect(reopened.status).toBe("started");
    if (reopened.status === "proposed") throw new Error("unreachable");
    expect(reopened.track.id).not.toBe(oldId);
    expect(reopened.track).toMatchObject({
      name: "Grow the newsletter",
      status: "active",
      direction: "Reach the people who already read us",
      verdict: null,
    });
    // The KPI's definition carries over; its last STATED value does not.
    expect(reopened.track.kpi).toMatchObject({
      label: "Subscribers",
      target: 500,
    });
    expect(reopened.track.kpi?.current).toBeUndefined();
    expect(await replacesEdges(reopened.track.id)).toEqual([oldId]);
    expect((await getTrack(oldId, human))!).toMatchObject({
      status: "completed",
      verdict: "met",
    });

    // Repeating the reopen hands back the same new version, idempotently…
    const again = await reopenTrack({ trackId: oldId, actor: human });
    expect(again.status).toBe("exists");
    if (again.status === "proposed") throw new Error("unreachable");
    expect(again.track.id).toBe(reopened.track.id);
  });

  it("refuses a live goal (nothing to reopen) and an old version already replaced", async () => {
    const live = await startTrack({
      projectId: REOPEN,
      name: "Still going",
      actor: human,
    });
    if (live.status === "proposed") throw new Error("unreachable");
    await expect(
      reopenTrack({ trackId: live.track.id, actor: human })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // v1 closed → v2 (replaces v1) closed → reopening v1 again is refused:
    // the line continues from the newest version.
    await setTrackStatus({
      trackId: live.track.id,
      status: "archived",
      verdict: "no_longer_needed",
      actor: human,
    });
    const v2 = await reopenTrack({ trackId: live.track.id, actor: human });
    if (v2.status === "proposed") throw new Error("unreachable");
    await setTrackStatus({
      trackId: v2.track.id,
      status: "completed",
      verdict: "not_met",
      actor: human,
    });
    await expect(
      reopenTrack({ trackId: live.track.id, actor: human })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const v3 = await reopenTrack({ trackId: v2.track.id, actor: human });
    expect(v3.status).toBe("started");
  });

  it("an AGENT reopen is proposed with the version it replaces; approval starts it AND links it", async () => {
    const started = await startTrack({
      projectId: REOPEN,
      name: "Win ten clients",
      actor: human,
    });
    if (started.status === "proposed") throw new Error("unreachable");
    await setTrackStatus({
      trackId: started.track.id,
      status: "completed",
      verdict: "partly_met",
      actor: human,
    });
    const filed = await reopenTrack({
      trackId: started.track.id,
      actor: agent,
    });
    expect(filed.status).toBe("proposed");
    const call = h.permCalls.at(-1)!;
    expect(call).toMatchObject({ subjectType: "track", action: "create" });
    const data = call.data as Record<string, unknown>;
    expect(data.replacesTrackId).toBe(started.track.id);

    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, target_type, proposal_type, data) values ($1, 'pending', 'track', 'create', $2::jsonb)`,
      [proposalId, JSON.stringify({ data })]
    );
    await proposalExecRegistry.resolveExact("track/create")!.execute({
      proposal: {
        id: proposalId,
        targetType: "track",
        proposalType: "create",
        workspaceId: null,
        agentUserId: AGENT,
        data: { data },
      },
      userId: USER,
      input: { proposalId },
      deps: {
        reportProposalOutcome: () => {},
        emitProposalReviewed: () => {},
      },
    } as unknown as ProposalExecutorArgs);
    expect(await replacesEdges(data.id as string)).toEqual([started.track.id]);
    expect((await getTrack(data.id as string, human))!.status).toBe("active");
  });
});

describe("what a goal holds (W2) — content, derived marks, acceptance, the close rule", () => {
  const GOALS2 = randomUUID();
  beforeAll(async () => {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Goals W2', 'active')`,
      [GOALS2, USER]
    );
  });
  const crit = (key: string, kind = "judge", extra: object = {}) => ({
    key,
    statement: `Criterion ${key}`,
    check: { kind },
    ...extra,
  });
  async function goal(name: string, extra: object = {}): Promise<string> {
    const res = await startTrack({
      projectId: GOALS2,
      name,
      actor: human,
      ...extra,
    });
    if (res.status === "proposed") throw new Error("unreachable");
    return res.track.id;
  }
  async function view(id: string) {
    const [v] = await loadTrackViews([(await getTrack(id, human))!], human);
    return v!;
  }
  async function fileSession(
    trackId: string,
    opts: {
      status?: string;
      keys?: string[];
      outputs?: unknown[];
      agentIds?: string[];
    } = {}
  ): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, track_id, project_id, status, goal, criteria, expected_outputs, agent_ids, metadata, created_at, updated_at)
       values ($1, $2, null, $3, $4, $5, 'work', $6::jsonb, $7::jsonb, $8, '{}'::jsonb, now(), now())`,
      [
        id,
        USER,
        trackId,
        GOALS2,
        opts.status ?? "active",
        JSON.stringify((opts.keys ?? []).map((k) => crit(k))),
        JSON.stringify(opts.outputs ?? []),
        opts.agentIds ?? [],
      ]
    );
    return id;
  }
  async function grade(
    sessionId: string,
    key: string,
    verdict: string,
    evaluatorKind: string,
    evaluatorId: string | null,
    at: string
  ) {
    await q(
      `insert into session_evaluations (id, session_id, user_id, criterion_key, attempt, verdict, evaluator_kind, evaluator_id, evidence, created_at)
       values (gen_random_uuid(), $1, $2, $3, 1, $4, $5, $6, '{}'::jsonb, $7)`,
      [sessionId, USER, key, verdict, evaluatorKind, evaluatorId, at]
    );
  }

  it("starts with what it holds, and the read returns it with derived marks", async () => {
    const id = await goal("Migrate the docs", {
      endState: " Every page lives on the new site ",
      criteria: [
        crit("pages", "evidence", {
          check: { kind: "evidence", evidenceKey: "pages" },
          checkKind: "measured",
        }),
        crit("tone"),
      ],
      dropConditions: ["The old site is retired first"],
      workKind: "project",
      uncertainty: "complicated",
    });
    const v = await view(id);
    expect(v).toMatchObject({
      endState: "Every page lives on the new site",
      dropConditions: ["The old site is retired first"],
      workKind: "project",
      uncertainty: "complicated",
      // A person wrote the kind: confirmed by them.
      kindConfirmedBy: USER,
      kindConfirmedAt: expect.any(String),
      inReview: false,
      waitingOn: [],
    });
    expect(v.criteria.map((c) => [c.key, c.mark, c.meaning])).toEqual([
      ["pages", "not_started", "measured"],
      ["tone", "not_started", "judged"],
    ]);
  });

  it("a goal has no criteria or 2 to 5 — one is refused at both doors, before governance", async () => {
    await expect(
      startTrack({
        projectId: GOALS2,
        name: "One criterion",
        criteria: [crit("only")],
        actor: human,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/2 to 5/),
    });
    const id = await goal("Lasting goal");
    h.permCalls.length = 0;
    await expect(
      setTrackDirection({
        trackId: id,
        criteria: Array.from({ length: 6 }, (_, i) => crit(`c${i}`)),
        actor: agent,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/not 6/),
    });
    expect(h.permCalls).toHaveLength(0);
    // A criterion cannot carry a decision the caller made up.
    await expect(
      setTrackDirection({
        trackId: id,
        criteria: [
          {
            ...crit("a"),
            acceptance: {
              decision: "accepted",
              by: USER,
              at: new Date().toISOString(),
            },
          },
          crit("b"),
        ],
        actor: human,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("an agent's kind is the AI's proposal: the approver confirms it; an agent may never confirm", async () => {
    const id = await goal("Keep the newsletter going");
    const filed = await setTrackDirection({
      trackId: id,
      workKind: "operation",
      uncertainty: "clear",
      actor: agent,
    });
    expect(filed.status).toBe("proposed");
    const data = h.permCalls.at(-1)!.data as Record<string, unknown>;
    expect(data).toMatchObject({ workKind: "operation", uncertainty: "clear" });
    await expect(
      setTrackDirection({ trackId: id, confirmKind: true, actor: agent })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Only a person confirms/),
    });

    const proposalId = randomUUID();
    await proposalExecRegistry.resolveExact("track/update")!.execute({
      proposal: {
        id: proposalId,
        targetType: "track",
        targetId: id,
        proposalType: "update",
        workspaceId: null,
        agentUserId: AGENT,
        data: { data },
      },
      userId: USER,
      input: { proposalId },
      deps: { reportProposalOutcome: () => {}, emitProposalReviewed: () => {} },
    } as unknown as ProposalExecutorArgs);
    expect(await view(id)).toMatchObject({
      workKind: "operation",
      uncertainty: "clear",
      kindConfirmedBy: USER,
    });
  });

  it("marks come from the sessions filed into the goal: claimed → in review; waiting on what its runs owe", async () => {
    const id = await goal("Ship the pricing page", {
      criteria: [crit("copy"), crit("legal", "human")],
    });
    const s1 = await fileSession(id, {
      status: "active",
      keys: ["copy", "legal"],
      outputs: [
        {
          kind: "document",
          label: "Key",
          owner: "human",
          blockedReason: "credential",
        },
        {
          kind: "document",
          label: "Pick",
          owner: "human",
          blockedReason: "decision",
        },
      ],
    });
    let v = await view(id);
    expect(v.criteria.map((c) => c.mark)).toEqual(["under_way", "under_way"]);
    expect(v.waitingOn).toEqual([
      { reason: "input", count: 1 },
      { reason: "access", count: 1 },
    ]);
    // An AI judge passes both: two CLAIMS, waiting on the judge — in review.
    await grade(s1, "copy", "pass", "judge", "model-x", "2026-10-21T10:00:00Z");
    await grade(
      s1,
      "legal",
      "pass",
      "judge",
      "model-x",
      "2026-10-21T10:00:00Z"
    );
    v = await view(id);
    expect(v.criteria.map((c) => [c.mark, c.acceptanceState])).toEqual([
      ["claimed", "waiting"],
      ["claimed", "waiting"],
    ]);
    expect(v.inReview).toBe(true);

    // Closing as met while the claims wait is refused, before governance.
    h.permCalls.length = 0;
    await expect(
      setTrackStatus({
        trackId: id,
        status: "completed",
        verdict: "met",
        actor: human,
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/not yet: copy, legal/),
    });
    expect(h.permCalls).toHaveLength(0);

    // The judge accepts both → met; no longer in review; the close lands.
    for (const key of ["copy", "legal"]) {
      const r = await acceptGoalCriterion({
        trackId: id,
        criterionKey: key,
        decision: "accepted",
        actor: human,
      });
      expect(r.status).toBe("updated");
    }
    v = await view(id);
    expect(v.criteria.map((c) => [c.mark, c.acceptance?.by])).toEqual([
      ["met", USER],
      ["met", USER],
    ]);
    expect(v.inReview).toBe(false);
    await expect(
      setTrackStatus({
        trackId: id,
        status: "completed",
        verdict: "partly_met",
        actor: human,
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/close it as met/),
    });
    const closed = await setTrackStatus({
      trackId: id,
      status: "completed",
      verdict: "met",
      actor: human,
    });
    expect(closed.status).toBe("updated");
  });

  it("acceptance: an agent never, a person only as the goal's judge; sending back needs words", async () => {
    const id = await goal("Judge only", { criteria: [crit("a"), crit("b")] });
    await expect(
      acceptGoalCriterion({
        trackId: id,
        criterionKey: "a",
        decision: "accepted",
        actor: agent,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/agent/),
    });
    await expect(
      acceptGoalCriterion({
        trackId: id,
        criterionKey: "a",
        decision: "changes_asked",
        actor: human,
      })
    ).rejects.toMatchObject({ message: expect.stringMatching(/needs a note/) });
    await expect(
      acceptGoalCriterion({
        trackId: id,
        criterionKey: "zzz",
        decision: "accepted",
        actor: human,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Someone else holds the goal's JUDGE seat (W3): USER still owns the goal
    // and can see and write the project, but is not the judge.
    await q(
      `insert into track_participants (track_id, principal_kind, principal_id, role, decided_by) values ($1, 'person', $2, 'judge', $3)`,
      [id, STRANGER, USER]
    );
    await expect(
      acceptGoalCriterion({
        trackId: id,
        criterionKey: "a",
        decision: "accepted",
        actor: human,
      })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/judge/),
    });
    await q(
      `delete from track_participants where track_id = $1 and role = 'judge'`,
      [id]
    );
  });

  it("a rewrite keeps the judge's decision on an unchanged criterion, and drops it on a changed one", async () => {
    const id = await goal("Rewritten criteria", {
      criteria: [crit("a"), crit("b")],
    });
    await acceptGoalCriterion({
      trackId: id,
      criterionKey: "a",
      decision: "accepted",
      actor: human,
    });
    await acceptGoalCriterion({
      trackId: id,
      criterionKey: "b",
      decision: "rejected",
      actor: human,
    });
    await setTrackDirection({
      trackId: id,
      criteria: [crit("a"), { ...crit("b"), statement: "Reworded" }],
      actor: human,
    });
    const v = await view(id);
    expect(
      v.criteria.map((c) => [c.key, c.acceptance?.decision ?? null])
    ).toEqual([
      ["a", "accepted"],
      ["b", null],
    ]);
  });

  it("R6 — an operation closes retired, never met; retired closes nothing else", async () => {
    const op = await goal("Keep the lights on", { workKind: "operation" });
    h.permCalls.length = 0;
    await expect(
      setTrackStatus({
        trackId: op,
        status: "completed",
        verdict: "met",
        actor: human,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/operation is never "met"/),
    });
    // Refused before governance: nothing was filed for a person to approve.
    expect(h.permCalls).toHaveLength(0);
    const closed = await setTrackStatus({
      trackId: op,
      status: "completed",
      verdict: "retired",
      actor: human,
    });
    expect(closed.status).toBe("updated");
    expect(
      (
        await q<{ status: string; verdict: string; verdict_by: string }>(
          `select status, verdict, verdict_by from project_tracks where id = $1`,
          [op]
        )
      ).rows[0]
    ).toEqual({ status: "completed", verdict: "retired", verdict_by: USER });
    expect((await view(op)).verdict).toBe("retired");

    const project = await goal("Ship the launch", { workKind: "project" });
    await expect(
      setTrackStatus({
        trackId: project,
        status: "completed",
        verdict: "retired",
        actor: human,
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Only an operation closes as retired/),
    });
    const unkinded = await goal("No kind said");
    await expect(
      setTrackStatus({
        trackId: unkinded,
        status: "completed",
        verdict: "retired",
        actor: human,
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Only an operation closes as retired/),
    });
  });
});
