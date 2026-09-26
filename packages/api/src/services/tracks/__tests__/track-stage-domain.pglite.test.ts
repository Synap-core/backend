/**
 * PER-STEP DOMAIN on PGlite (W2a, concept consolidation) — the REAL tracks
 * service, the REAL `createFocusSession`, the REAL `focus_session/create`
 * executor, the REAL `uses` door (`linkProjectToWorkspace` →
 * `listWorkspacesUsedByProjects`, read back from PGlite: reachability, not
 * shape).
 *
 *   D1 `startTrack` lists stage domains with no live workspace the caller can
 *      see (`missingDomains`) — advisory, never a refusal;
 *   D2 a stage with a domain starts its session in a workspace of that
 *      template, prefers one the project already uses, else the earliest, and
 *      stamps `project --uses--> workspace`;
 *   D3 no usable workspace ⇒ the project's home + a structured
 *      `domainFallback` naming WHY (no_workspace / not_a_domain_home /
 *      no_write_access), and another user's workspace never leaks in;
 *   D4 an agent PROPOSES into the domain workspace (no stamp yet); after the
 *      approval replay, the door returns the session and stamps `uses` then.
 *
 * Stubbed, only at infrastructure seams (same as track-stages.pglite.test.ts):
 * `checkPermissionOrPropose` (proposes for an agent, grants a human),
 * `createLinks` (the provenance edge), `emitSideEffects`, the EventRepository
 * append, `ensureSessionChannel`, realtime, `resolveSessionProjectPlacement`,
 * the blocked-slot guidance. `createLink` (singular — the `uses` door's
 * insert) writes a REAL `links` row.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
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
      // `getWorkspaceMembership` (the write probe) reads through the query API.
      workspaceMembers: actual.workspaceMembers as never,
    },
  });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    EventRepository: class {
      async append() {}
    },
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async (
      _db: unknown,
      input: { explicitProjectId?: string | null }
    ) => ({ projectId: input.explicitProjectId ?? null }),
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
  createEventBackedProposal: async () => ({
    proposal: { id: randomUUID(), status: "pending" },
  }),
}));
vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
  createLink: async (l: {
    workspaceId: string | null;
    fromType: string;
    fromId: string;
    toType: string;
    toId: string;
    linkType: string;
  }) => {
    await h.client!.query(
      `insert into links (workspace_id, from_type, from_id, to_type, to_id, link_type)
       select $1, $2, $3, $4, $5, $6
       where not exists (select 1 from links where from_type=$2 and from_id=$3 and to_type=$4 and to_id=$5 and link_type=$6)`,
      [l.workspaceId, l.fromType, l.fromId, l.toType, l.toId, l.linkType]
    );
    return {};
  },
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
vi.mock("../../focus-sessions/ensure-session-channel.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureSessionChannel: async () => null,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../focus-sessions/block-guidelines.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  playbooks,
  projects,
  proposals,
  workspaces,
  workspaceMembers,
  podMembers,
  projectMembers,
  users,
  links,
  sessionEvaluations,
} from "@synap/database";
import { startStageSession, startTrack } from "../tracks-service.js";
import { listWorkspacesUsedByProjects } from "../../../utils/project-workspace.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import type { ProposalExecutorArgs } from "../../../routers/proposals/execution-registry.js";

const USER = "user-1";
const OTHER = "user-2";
const AGENT = "agent-1";
const METHOD = randomUUID();

// Workspaces (created_at order matters: A is the earliest crm install).
const CRM_A = randomUUID();
const CRM_B = randomUUID();
const OPS = randomUUID(); // operational ⇒ not a domain home
const LEGAL = randomUUID(); // USER is only a viewer
const OTHERS_FIN = randomUUID(); // finance, owned by OTHER, invisible to USER

const STAGES = [
  { key: "sell", name: "Sell", category: "planned", domain: "crm" },
  { key: "fund", name: "Fund", category: "started", domain: "finance" },
  { key: "run", name: "Run", category: "started", domain: "operations" },
  { key: "sign", name: "Sign", category: "started", domain: "legal" },
  { key: "home", name: "Home", category: "completed" },
];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "started_at" || c.name === "created_at"
          ? " default now()"
          : c.name === "metadata" || c.name === "settings"
            ? " default '{}'::jsonb"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const human = { userId: USER };
const agent = { userId: USER, agentUserId: AGENT, isHubProtocol: true };

async function newProject(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'P', 'active')`,
    [id, USER]
  );
  return id;
}

async function newTrack(projectId: string): Promise<string> {
  const res = await startTrack({
    projectId,
    playbookId: METHOD,
    actor: human,
  });
  if (res.status === "proposed") throw new Error("unexpected proposal");
  return res.track.id;
}

async function sessionWorkspace(id: string): Promise<string | null> {
  const [row] = (
    await q<{ workspace_id: string | null }>(
      `select workspace_id from focus_sessions where id = $1`,
      [id]
    )
  ).rows;
  return row!.workspace_id;
}

async function usedBy(projectId: string): Promise<string[]> {
  const { getDb } = await import("@synap/database");
  return (
    (await listWorkspacesUsedByProjects(await getDb(), [projectId], USER)).get(
      projectId
    ) ?? []
  );
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    workspaces,
    workspaceMembers,
    podMembers,
    projectMembers,
    links,
    playbooks,
    projects,
    sessionEvaluations,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
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
      status text not null default 'active',
      params jsonb not null default '{}'::jsonb,
      stage_history jsonb not null default '[]'::jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await q(`insert into users (id) values ($1), ($2)`, [USER, OTHER]);
  const ws: Array<[string, string, string, string, string]> = [
    // id, name, package_slug, type, owner
    [CRM_A, "CRM", "crm", "personal", USER],
    [CRM_B, "CRM 2", "crm", "personal", USER],
    [OPS, "Ops", "operations", "operational", USER],
    [LEGAL, "Legal", "legal", "personal", OTHER],
    [OTHERS_FIN, "Finance", "finance", "personal", OTHER],
  ];
  let minute = 0;
  for (const [id, name, slug, type, owner] of ws) {
    await q(
      `insert into workspaces (id, name, package_slug, workspace_type, owner_id, created_at)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)`,
      [id, name, slug, type, owner, String(minute++)]
    );
  }
  for (const [wsId, userId, role] of [
    [CRM_A, USER, "owner"],
    [CRM_B, USER, "owner"],
    [OPS, USER, "owner"],
    [LEGAL, OTHER, "owner"],
    [LEGAL, USER, "viewer"],
    [OTHERS_FIN, OTHER, "owner"],
  ]) {
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)`,
      [wsId, userId, role]
    );
  }
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, version, executor, status, scope, metadata, created_at, updated_at)
     values ($1, null, $2, 'Across domains', 'Do it', '[]', '{"kind":"none"}', '{}', '[]', $3::jsonb, '[]', 1, 'is-agent', 'active', 'project', '{}', now(), now())`,
    [METHOD, USER, JSON.stringify(STAGES)]
  );
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(() => {
  h.permCalls.length = 0;
});

describe("D1 startTrack — missingDomains (advisory)", () => {
  it("lists stage domains with no live workspace visible to the caller, in stage order, and still starts", async () => {
    const res = await startTrack({
      projectId: await newProject(),
      playbookId: METHOD,
      actor: human,
    });
    expect(res.status).toBe("started");
    // crm (2 installs), operations (operational — still installed), legal
    // (viewer — visible) are present; finance exists only for OTHER.
    expect(res.missingDomains).toEqual(["finance"]);
  });

  it("an archived install does not count", async () => {
    await q(`update workspaces set archived_at = now() where id = $1`, [OPS]);
    try {
      const res = await startTrack({
        projectId: await newProject(),
        playbookId: METHOD,
        actor: human,
      });
      expect(res.missingDomains).toEqual(["finance", "operations"]);
    } finally {
      await q(`update workspaces set archived_at = null where id = $1`, [OPS]);
    }
  });
});

describe("D2 the stage session is worked in its domain", () => {
  it("no prior use ⇒ the EARLIEST writable install; the `uses` edge is stamped", async () => {
    const project = await newProject();
    const trackId = await newTrack(project);
    const res = await startStageSession({
      trackId,
      stageKey: "sell",
      actor: human,
    });
    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    expect(await sessionWorkspace(res.session.id)).toBe(CRM_A);
    expect(res.domain).toEqual({
      wanted: "crm",
      workspaceId: CRM_A,
      usesStamped: true,
    });
    expect(res.domainFallback).toBeUndefined();
    expect(await usedBy(project)).toEqual([CRM_A]);
  });

  it("prefers the install the project ALREADY uses over the earliest", async () => {
    const project = await newProject();
    await q(
      `insert into links (workspace_id, from_type, from_id, to_type, to_id, link_type) values ($1, 'project', $2, 'workspace', $3, 'uses')`,
      [CRM_B, project, CRM_B]
    );
    const trackId = await newTrack(project);
    const res = await startStageSession({
      trackId,
      stageKey: "sell",
      actor: human,
    });
    if (res.status !== "created") throw new Error(res.status);
    expect(await sessionWorkspace(res.session.id)).toBe(CRM_B);
    expect(await usedBy(project)).toEqual([CRM_B]);
  });

  it("a stage with NO domain stays in the project's home, with nothing to report", async () => {
    const project = await newProject();
    const trackId = await newTrack(project);
    const res = await startStageSession({
      trackId,
      stageKey: "home",
      actor: human,
    });
    if (res.status !== "created") throw new Error(res.status);
    expect(await sessionWorkspace(res.session.id)).toBeNull();
    expect(res.domain).toBeUndefined();
    expect(res.domainFallback).toBeUndefined();
    expect(await usedBy(project)).toEqual([]);
  });
});

describe("D3 no usable workspace ⇒ home + an honest reason", () => {
  it.each([
    ["fund", "finance", "no_workspace"],
    ["run", "operations", "not_a_domain_home"],
    ["sign", "legal", "no_write_access"],
  ] as const)(
    "stage %s (domain %s) falls back with reason %s",
    async (stageKey, wanted, reason) => {
      const project = await newProject();
      const trackId = await newTrack(project);
      const res = await startStageSession({
        trackId,
        stageKey,
        actor: human,
      });
      if (res.status !== "created") throw new Error(res.status);
      // Home of a pod-personal project = no workspace.
      expect(await sessionWorkspace(res.session.id)).toBeNull();
      expect(res.domainFallback).toEqual({ wanted, reason });
      expect(res.domain).toBeUndefined();
      expect(await usedBy(project)).toEqual([]);
    }
  );

  it("NO LEAK: another user's finance workspace is never used, and reads as absent", async () => {
    const project = await newProject();
    const trackId = await newTrack(project);
    const res = await startStageSession({
      trackId,
      stageKey: "fund",
      actor: human,
    });
    if (res.status !== "created") throw new Error(res.status);
    expect(await sessionWorkspace(res.session.id)).not.toBe(OTHERS_FIN);
    expect(res.domainFallback?.reason).toBe("no_workspace");
  });
});

describe("D4 an agent proposes into the domain; the stamp follows the approval", () => {
  it("proposes focus_session/create IN the domain workspace, stamps nothing, then stamps on the next start", async () => {
    const project = await newProject();
    const trackId = await newTrack(project);
    const res = await startStageSession({
      trackId,
      stageKey: "sell",
      actor: agent,
    });
    expect(res.status).toBe("proposed");
    expect(res.domain).toEqual({
      wanted: "crm",
      workspaceId: CRM_A,
      usesStamped: false,
    });
    const call = h.permCalls.find((c) => c.subjectType === "focus_session")!;
    expect(call.workspaceId).toBe(CRM_A);
    expect(await usedBy(project)).toEqual([]);

    // Approval replay — the proposal row carries the domain workspace.
    const data = call.data as Record<string, unknown>;
    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data) values ($1, 'pending', 'focus_session', $2, 'create', $3::jsonb)`,
      [proposalId, data.id, JSON.stringify({ data })]
    );
    await proposalExecRegistry.resolveExact("focus_session/create")!.execute({
      proposal: {
        id: proposalId,
        targetType: "focus_session",
        targetId: data.id,
        proposalType: "create",
        workspaceId: CRM_A,
        sessionId: null,
        projectId: project,
        subjectUserId: USER,
        correlationId: null,
        agentUserId: AGENT,
        data: { data },
      },
      payload: null,
      userId: USER,
      input: { proposalId },
      ctx: {},
      deps: { reportProposalOutcome: () => {}, emitProposalReviewed: () => {} },
    } as unknown as ProposalExecutorArgs);
    expect(await sessionWorkspace(data.id as string)).toBe(CRM_A);

    const again = await startStageSession({
      trackId,
      stageKey: "sell",
      actor: agent,
    });
    expect(again.status).toBe("existing");
    expect(again.domain).toEqual({
      wanted: "crm",
      workspaceId: CRM_A,
      usesStamped: true,
    });
    expect(await usedBy(project)).toEqual([CRM_A]);
  });
});
