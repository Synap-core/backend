/**
 * AN AGENT-AUTHORED METHOD CARRIES ITS OWN ONBOARDING — end to end on PGlite.
 *
 * Before 2026-09-28 the agent doors (`synap_create_playbook`, Hub
 * `POST /playbooks`) went through a hand-written body schema / door input that
 * carried `scope` + `stages` but no `params`: an agent could author a METHOD
 * but never declare what it needs to know, so a track of it asked the person
 * nothing. This drives the whole seam with nothing hand-built in between:
 *
 *   REAL MCP handler `synap_create_playbook` (agent key)
 *     → REAL `createPlaybookDoor` → REAL `playbooks.create` (ONE schema)
 *     → the gate PROPOSES (agent) — the proposal's `data` is what was captured
 *   → REAL `playbook/create` approve executor replays it as the human
 *     → a real `playbooks` row in PGlite
 *   → REAL `startTrack` on a project (no param answered)
 *   → REAL `startStageSession` → the session row's owed PARAM slot, owed by the
 *     person, labelled with the param's question.
 *
 * Stubbed, only at infrastructure seams: `checkPermissionOrPropose` /
 * `previewPermissionDecision` (propose for an agent, grant a human), link
 * writes, side-effect emits, the session channel, realtime, blocked-slot
 * guidance, and project placement (echoes the pin).
 *
 * NOT covered: the Hub REST wrapper's Hono parse (its body schema is the ONE
 * schema's `.pick`, pinned by `playbook-definition-one-schema.test.ts`).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  proposed: [] as Array<Record<string, unknown>>,
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
      workspaces: actual.workspaces as never,
      workspaceMembers: actual.workspaceMembers as never,
      proposals: actual.proposals as never,
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

vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  previewPermissionDecision: async () => ({ decision: "propose" }),
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    if (opts.agentUserId) {
      const proposalId = randomUUID();
      h.proposed.push({ ...opts, proposalId });
      return {
        granted: false,
        proposalId,
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
// protectedProcedure's two DB-touching middlewares (pod read-only flag, audit).
vi.mock("../../../middleware/read-only-guard.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../../../middleware/audit-log.js", async () => {
  const { t } = await import("../../../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../../links/links-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createLinks: async () => [],
  getLinksFor: async () => [],
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
  users,
  links,
  sessionEvaluations,
  podMembers,
  projectMembers,
} from "@synap/database";
import { PARAM_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { buildHandlers } from "../../../routers/mcp/handlers/build.js";
import type { McpToolContext } from "../../../routers/mcp/handlers/shared.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import type { ProposalExecutorArgs } from "../../../routers/proposals/execution-registry.js";
import { registerPlaybookExecutors } from "../../../routers/proposals/executors/playbook.js";
import { startStageSession, startTrack } from "../tracks-service.js";

const USER = "user-1";
const AGENT = randomUUID();
const WS = randomUUID();
const PROJECT = randomUUID();

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
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of [
    focusSessions,
    proposals,
    users,
    workspaces,
    workspaceMembers,
    links,
    playbooks,
    projects,
    sessionEvaluations,
    podMembers,
    projectMembers,
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
      direction text,
      kpi jsonb,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);
  await q(`insert into users (id, email) values ($1, $2)`, [
    USER,
    `${USER}@example.test`,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Grants', $2)`,
    [WS, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, USER]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, $3, 'Stellar grant', 'active')`,
    [PROJECT, USER, WS]
  );
  registerPlaybookExecutors();
}, 120_000);

function agentCtx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_create_playbook",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
    requestedWorkspaceId: WS,
    workspaceAccessible: true,
  } as unknown as McpToolContext;
}

describe("agent-authored method → approved → track → owed question", () => {
  it("a required param the agent declared becomes a question owed to the person when the track's stage session starts", async () => {
    // 1. The agent authors a project-scope method WITH a required param.
    const created = await buildHandlers.synap_create_playbook!(
      agentCtx({
        name: "Grant application",
        goalTemplate: "Apply to {funder}",
        scope: "project",
        stages: [
          {
            key: "draft",
            name: "Draft",
            category: "started",
            goal: "Draft the application for {funder}",
          },
          { key: "submit", name: "Submit", category: "completed" },
        ],
        params: [
          {
            name: "funder",
            label: "Which funder are we applying to?",
            type: "text",
            required: true,
          },
        ],
        criteria: [
          {
            key: "submitted",
            statement: "The application was submitted",
            check: { kind: "human" },
          },
        ],
      })
    );
    expect(JSON.stringify(created)).toContain("proposed");
    const filed = h.proposed.find((p) => p.subjectType === "playbook")!;
    expect(filed).toBeDefined();
    const data = filed.data as Record<string, unknown>;

    // 2. The person approves: the REAL executor replays the stored input.
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data, workspace_id) values ($1, 'pending', 'playbook', $2, 'create', $3::jsonb, $4)`,
      [filed.proposalId, String(filed.proposalId), JSON.stringify({ data }), WS]
    );
    const executor = proposalExecRegistry.resolveExact("playbook/create")!;
    await executor.execute({
      proposal: {
        id: filed.proposalId,
        targetType: "playbook",
        targetId: filed.proposalId,
        proposalType: "create",
        workspaceId: WS,
        sessionId: null,
        subjectUserId: USER,
        correlationId: null,
        agentUserId: AGENT,
        data: { data },
      },
      payload: null,
      userId: USER,
      input: { proposalId: filed.proposalId },
      ctx: {},
      deps: {
        reportProposalOutcome: () => {},
        emitProposalReviewed: () => {},
      },
    } as unknown as ProposalExecutorArgs);

    const [row] = (
      await q<{
        id: string;
        scope: string;
        params: unknown;
        criteria: unknown;
      }>(
        `select id, scope, params, criteria from playbooks where name = 'Grant application'`
      )
    ).rows;
    expect(row?.scope).toBe("project");
    expect(row?.params).toEqual([
      expect.objectContaining({ name: "funder", required: true }),
    ]);
    expect(row?.criteria).toEqual([
      expect.objectContaining({ key: "submitted" }),
    ]);

    // 3. The person starts the method on a project, answering nothing.
    const started = await startTrack({
      projectId: PROJECT,
      playbookId: row!.id,
      actor: { userId: USER },
    });
    if (started.status === "proposed") throw new Error("unexpected proposal");

    // 4. The stage session owes the person the unanswered question.
    const stage = await startStageSession({
      trackId: started.track.id,
      actor: { userId: USER },
    });
    expect(stage.status).toBe("created");
    if (stage.status !== "created") return;
    const [session] = (
      await q<{ expected_outputs: Array<Record<string, unknown>> }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [stage.session.id]
      )
    ).rows;
    expect(
      session!.expected_outputs.find((o) => o.kind === PARAM_SLOT_KIND)
    ).toMatchObject({
      label: "Answer: Which funder are we applying to?",
      owner: "human",
    });
  });
});
