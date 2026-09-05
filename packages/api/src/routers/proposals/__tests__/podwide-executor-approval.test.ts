/**
 * POD-WIDE proposal approval must MATERIALIZE, not 403/400.
 *
 * THE BUG. `review-authority.ts` was made pod-wide-aware (a NULL-workspace
 * proposal is decided by owner / agent-owner / pod-admin), so the reviewer
 * passed the gate and saw the Approve button. The EXECUTORS — the write half —
 * were not:
 *
 *   · `entity/update` called `getWorkspaceMembership(db, proposal.workspaceId!, …)`.
 *     The `!` masked a runtime NULL, so the query became
 *     `eq(workspace_members.workspace_id, NULL)` — a predicate that can NEVER
 *     match — and every pod-wide approval threw FORBIDDEN "No workspace access".
 *     `entities.workspaceId` NULL means "global" (schema doctrine), so this is
 *     the single most common pod-wide object there is.
 *   · `project/update` threw BAD_REQUEST "Pod-wide projects cannot be updated
 *     through a proposal (workspaceProcedure requires a workspace)" — a premise
 *     that is stale: `projectsRouter.update` and `setAutomationMembership` are
 *     both `podProcedure` and handle a NULL workspace explicitly.
 *
 * Either way the proposal was stuck PENDING forever with no path forward.
 *
 * WHAT AUTHORIZES A POD-WIDE APPROVAL AFTER THE FIX — and why removing the
 * membership lookup does NOT widen anything:
 *   1. `computeCanReviewApproval` (review-authority.ts) runs in BOTH approve
 *      doors BEFORE `applyProposalApproval` dispatches to any executor, and for
 *      a NULL workspace it admits ONLY the proposal's owner, the human who owns
 *      the acting agent, or a pod-admin. Pinned below + in
 *      `review-authority-podwide.test.ts`.
 *   2. The replayed router mutation re-applies its OWN floor as the write
 *      executes — `entities.update` via `entityWriteVisibleWhere(userId)`,
 *      `projects.update` via `loadVisibleProject` + `ProjectRepository.update`'s
 *      `eq(projects.userId, …)` ownership predicate.
 * The membership row was a THIRD gate that could only ever speak "workspace";
 * for a pod-wide row it denied everyone, including the two authorities above.
 *
 * These are EXECUTABLE (the module's DB + router access is mocked) — they fail
 * on the old `!`/BAD_REQUEST and pass on the branch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import type {
  ProposalExecutorArgs,
  ProposalExecutorDeps,
} from "../execution-registry.js";

// ── mutable fixture state the mocks read ───────────────────────────────────
let membership: { role: string } | undefined;
let membershipCalls: Array<string | null | undefined> = [];
let projectRow:
  { id: string; workspaceId: string | null; userId: string } | undefined;
let selectRows: Array<{ status: string }> = [];
const proposalUpdates: Array<Record<string, unknown>> = [];
const entityUpdateCalls: Array<{ ctx: CallerCtx; args: unknown }> = [];
const projectUpdateCalls: Array<{ ctx: CallerCtx; args: unknown }> = [];

interface CallerCtx {
  userId: string;
  workspaceId: string | null | undefined;
  workspaceRole: string | undefined;
}

// ── module mocks ───────────────────────────────────────────────────────────
const dbStub = {
  query: {
    entities: { findFirst: async () => undefined },
    projects: { findFirst: async () => projectRow },
  },
  select: () => ({ from: () => ({ where: async () => selectRows }) }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        proposalUpdates.push(values);
      },
    }),
  }),
};

vi.mock("@synap/database", () => {
  // A total vi.mock REPLACES the module wholesale, so any export the source
  // chain newly imports becomes undefined and every test in this file dies.
  // That has happened repeatedly here (store-entity-source-blob.js pulled in
  // a large transitive graph). The Proxy below returns a benign stub for any
  // export not explicitly listed, so a new import upstream cannot silently
  // break this file; explicit entries still win.
  const base: Record<string, unknown> = {
    db: dbStub,
    // Pulled in transitively via store-entity-source-blob.js (source-file
    // staging on approval). A total vi.mock replaces the module wholesale,
    // so every export the source chain imports must be declared here.
    DocumentRepository: class {},
    EntityRepository: class {},
    eventRepository: { record: async () => null },
    documentVersionSnapshotFromUpload: () => ({}),
    automationRuns: { __table: "automation_runs" },
    focusSessions: { __table: "focus_sessions" },
    channels: { __table: "channels" },
    governanceRules: { __table: "governance_rules" },
    governanceCeilings: { __table: "governance_ceilings" },
    ne: () => ({}),
    createGuideline: async () => null,
    linkEntityToProject: async () => null,
    resolveProjectPlacement: async () => null,
    setChannelBranchPurpose: async () => null,
    storedVersionValues: () => ({}),
    uploadDocumentVersionSnapshot: async () => ({}),
    ChannelFirewallImmutableError: class extends Error {},
    proposals: { __table: "proposals" },
    projects: { __table: "projects" },
    entities: { __table: "entities" },
    links: { __table: "links" },
    workspaces: { __table: "workspaces" },
    relations: { __table: "relations" },
    projectMembers: { __table: "project_members" },
    eq: () => ({}),
    and: () => ({}),
    isNull: () => ({}),
    sql: {},
    drizzleSql: Object.assign(() => ({}), { raw: () => ({}) }),
    getWorkspaceMembership: async (_db: unknown, wsId: string | null) => {
      membershipCalls.push(wsId);
      return membership;
    },
    ProjectRepository: class {},
    EventRepository: class {},
    ProfileResolutionService: class {},
    PropertyIndexService: class {},
    mergeEntities: async () => ({}),
    resolveMaterializedEntityWorkspaceId: async () => null,
    isDomainHomeWorkspace: async () => false,
    DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE: "domain-home",
  };
  return new Proxy(base, {
    get(target, key) {
      if (typeof key === "symbol" || key in target)
        return target[key as string];
      // `then` MUST stay undefined: a module namespace exposing a callable
      // `then` is treated as a thenable, so `await import(...)` never
      // resolves and the whole file hangs instead of failing.
      if (key === "then" || key === "__esModule") return undefined;
      const stub = (() => ({})) as unknown as Record<string, unknown>;
      stub.__table = String(key);
      return stub;
    },
    has: () => true,
  });
});

vi.mock("@synap/database/schema", () => ({
  ProposalStatus: { APPROVED: "approved", PENDING: "pending" },
}));

vi.mock("@synap/events", () => ({ emitSideEffects: () => {} }));

vi.mock("../../entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: CallerCtx) => ({
      update: async (args: unknown) => {
        entityUpdateCalls.push({ ctx, args });
        return {};
      },
      delete: async () => ({}),
      create: async () => ({}),
    }),
  },
  mergeSystemData: (a: unknown, b: unknown) => ({
    ...(a as object),
    ...(b as object),
  }),
}));

vi.mock("../../projects.js", () => ({
  projectsRouter: {
    createCaller: (ctx: CallerCtx) => ({
      update: async (args: unknown) => {
        projectUpdateCalls.push({ ctx, args });
        return {};
      },
      create: async () => ({}),
      setAutomationMembership: async (args: unknown) => {
        projectUpdateCalls.push({ ctx, args });
        return {};
      },
    }),
  },
}));

vi.mock("../../../services/proposals/reconcile-proposal-properties.js", () => ({
  reconcileApprovedProperties: async (a: { properties: unknown }) => ({
    properties: a.properties,
  }),
}));

vi.mock("../../../services/proposals/complete-knowledge-proposal.js", () => ({
  completeKnowledgeProposalProperties: async (p: unknown) => p,
}));

vi.mock("../../../utils/audit-log.js", () => ({ auditLog: async () => null }));

const { proposalExecRegistry } = await import("../execution-registry.js");
const { registerEntityExecutors } = await import("../executors/entity.js");
const { registerProjectExecutors } = await import("../executors/project.js");

registerEntityExecutors();
registerProjectExecutors();

const APPROVER = "human-approver";
const OTHER_MEMBER = "some-other-member";

const deps = {
  db: dbStub,
  emitProposalReviewed: () => {},
  reportProposalOutcome: () => {},
  stampProjectMembership: async () => {},
  resolveMessagingAccountForPlatform: async () => null,
} as unknown as ProposalExecutorDeps;

function runArgs(
  proposal: { workspaceId: string | null; data: unknown; targetId?: string },
  userId = APPROVER
): ProposalExecutorArgs {
  return {
    proposal: {
      id: "prop-1",
      targetType: "entity",
      targetId: proposal.targetId ?? "target-1",
      proposalType: "update",
      workspaceId: proposal.workspaceId,
      sessionId: null,
      projectId: null,
      agentUserId: null,
      sourceMessageId: null,
      data: proposal.data,
    },
    payload: null,
    userId,
    input: { proposalId: "prop-1" },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps,
  };
}

function executor(key: string) {
  const ref = proposalExecRegistry.resolveExact(key);
  if (!ref) throw new Error(`no executor registered for ${key}`);
  return ref;
}

beforeEach(() => {
  membership = undefined;
  membershipCalls = [];
  projectRow = undefined;
  selectRows = [];
  proposalUpdates.length = 0;
  entityUpdateCalls.length = 0;
  projectUpdateCalls.length = 0;
});

describe("entity/update — pod-wide (NULL workspaceId) approval", () => {
  it("MATERIALIZES a pod-wide entity update instead of throwing FORBIDDEN", async () => {
    const result = await executor("entity/update").execute(
      runArgs({ workspaceId: null, data: { data: { id: "e-1", title: "T" } } })
    );

    expect(result).toEqual({ success: true });
    expect(entityUpdateCalls).toHaveLength(1);
    // Ran at POD scope, as the approver.
    expect(entityUpdateCalls[0].ctx).toMatchObject({
      userId: APPROVER,
      workspaceId: null,
      workspaceRole: "owner",
    });
    // The membership lookup that can never match NULL is not even attempted.
    expect(membershipCalls).toEqual([]);
    expect(proposalUpdates[0]).toMatchObject({
      status: "approved",
      reviewedBy: APPROVER,
    });
  });

  it("workspace-scoped: UNCHANGED — verifies membership and carries its role", async () => {
    membership = { role: "editor" };

    await executor("entity/update").execute(
      runArgs({
        workspaceId: "ws-1",
        data: { data: { id: "e-1", title: "T" } },
      })
    );

    expect(membershipCalls).toEqual(["ws-1"]);
    expect(entityUpdateCalls[0].ctx).toMatchObject({
      userId: APPROVER,
      workspaceId: "ws-1",
      workspaceRole: "editor",
    });
  });

  it("workspace-scoped NEGATIVE: a non-member is still REJECTED and nothing is written", async () => {
    membership = undefined;

    await expect(
      executor("entity/update").execute(
        runArgs({ workspaceId: "ws-1", data: { data: { id: "e-1" } } })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(entityUpdateCalls).toEqual([]);
    expect(proposalUpdates).toEqual([]);
  });
});

describe("project/update — pod-personal (NULL workspaceId) approval", () => {
  it("MATERIALIZES a pod-personal project update instead of throwing BAD_REQUEST", async () => {
    projectRow = { id: "p-1", workspaceId: null, userId: OTHER_MEMBER };

    const result = await executor("project/update").execute(
      runArgs({
        workspaceId: null,
        targetId: "p-1",
        data: { data: { id: "p-1", name: "Renamed" } },
      })
    );

    expect(result).toMatchObject({ success: true });
    expect(projectUpdateCalls).toHaveLength(1);
    // Executes as the project's OWNER (ProjectRepository.update gates on
    // `projects.userId`) at pod scope — the same identity choice the
    // workspace path and `project/archive` already make.
    expect(projectUpdateCalls[0].ctx).toMatchObject({
      userId: OTHER_MEMBER,
      workspaceId: undefined,
      workspaceRole: undefined,
    });
    expect(membershipCalls).toEqual([]);
  });

  it("workspace-scoped: UNCHANGED — verifies membership on the PROJECT ROW's workspace", async () => {
    projectRow = { id: "p-1", workspaceId: "ws-9", userId: OTHER_MEMBER };
    membership = { role: "admin" };

    await executor("project/update").execute(
      runArgs({
        workspaceId: "ws-1",
        targetId: "p-1",
        data: { data: { id: "p-1", name: "Renamed" } },
      })
    );

    // The row's workspace, never the proposal's.
    expect(membershipCalls).toEqual(["ws-9"]);
    expect(projectUpdateCalls[0].ctx).toMatchObject({
      userId: OTHER_MEMBER,
      workspaceId: "ws-9",
      workspaceRole: "admin",
    });
  });

  it("workspace-scoped NEGATIVE: a non-member is still REJECTED and nothing is written", async () => {
    projectRow = { id: "p-1", workspaceId: "ws-9", userId: OTHER_MEMBER };
    membership = undefined;

    await expect(
      executor("project/update").execute(
        runArgs({
          workspaceId: "ws-1",
          targetId: "p-1",
          data: { data: { id: "p-1", name: "Renamed" } },
        })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(projectUpdateCalls).toEqual([]);
    expect(proposalUpdates).toEqual([]);
  });
});

/**
 * The executors no longer carry an authorization check for the pod-wide case —
 * by design (it was structurally incapable of admitting anyone). That is only
 * safe while the ONE predicate that IS pod-wide-aware runs first, in both
 * approve doors. Pin the ORDER in the source, so deleting or reordering the
 * gate fails here rather than silently making the executors the only gate.
 */
describe("the pod-wide authority gate runs BEFORE any executor dispatch", () => {
  const ROUTER = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../proposals.ts"
    ),
    "utf-8"
  );

  it("approve: computeCanReviewApproval precedes applyProposalApproval", () => {
    const gate = ROUTER.indexOf("const { allowed: canApprove }");
    const apply = ROUTER.indexOf(
      "return await applyProposalApproval({ proposal, userId, input, ctx });"
    );
    expect(gate).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(apply);
  });

  it("BOTH approve doors dispatch only through applyProposalApproval", () => {
    expect(ROUTER.match(/await applyProposalApproval\(/g)?.length).toBe(2);
    expect(ROUTER.match(/await computeCanReviewApproval\(/g)?.length).toBe(3);
  });
});
