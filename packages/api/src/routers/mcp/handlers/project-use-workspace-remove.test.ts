/**
 * `synap_project_use_workspace {remove:true}` — the governed remove door for a
 * project's `uses` INDEX edge, and its approval half (`link/delete`).
 *
 * What these assert:
 *  - remove files `checkPermissionOrPropose` as a LINK DELETE with the same
 *    endpoint payload the add files (so display, the endpoint floor and the
 *    approval executor all read one shape) — never a create;
 *  - an agent's remove that proposes comes back `proposed` and removes nothing;
 *  - a direct (auto) remove calls `unlinkProjectFromWorkspace`, never the add;
 *  - the endpoint floor refuses BEFORE governance, same as the add;
 *  - without `remove` the add path is untouched;
 *  - the `link/delete` executor replays through `unlinkProjectFromWorkspace`,
 *    floored on the proposal's SUBJECT user (not the approver), refuses any
 *    other link shape, and reports the DELETE's own row count.
 *
 * No database: governance, the floor and the util are mocked at the module
 * seam — the unlink SQL itself is proven on PGlite in
 * `utils/project-workspace.unlink.pglite.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  perm: vi.fn(),
  refusal: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
  proposalStatus: "pending" as string,
  updates: [] as unknown[],
}));

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: (...a: unknown[]) => h.perm(...a),
}));
vi.mock("../../hub-protocol/rest/link-endpoint-visibility.js", () => ({
  checkLinkEndpointsVisible: (...a: unknown[]) => h.refusal(...a),
}));
vi.mock("../../../utils/project-workspace.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../utils/project-workspace.js")
    >();
  return {
    ...actual,
    linkProjectToWorkspace: (...a: unknown[]) => h.link(...a),
    unlinkProjectFromWorkspace: (...a: unknown[]) => h.unlink(...a),
  };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({}),
    db: {
      select: () => ({
        from: () => ({
          where: async () => [{ status: h.proposalStatus }],
        }),
      }),
      update: () => ({
        set: (v: unknown) => ({
          where: async () => {
            h.updates.push(v);
          },
        }),
      }),
    },
  };
});

import { workspaceHandlers } from "./workspace.js";
import type { McpToolContext } from "./shared.js";
import { proposalExecRegistry } from "../../proposals/execution-registry.js";
import { registerLinkExecutors } from "../../proposals/executors/link.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const WS = "33333333-3333-4333-8333-333333333333";
const APPROVER = "55555555-5555-4555-8555-555555555555";

async function call(args: Record<string, unknown>) {
  const handler = workspaceHandlers.synap_project_use_workspace!;
  const res = await handler({
    toolName: "synap_project_use_workspace",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
    sessionId: null,
  } as unknown as McpToolContext);
  const text = (res.content as { type: string; text: string }[])[0].text;
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  h.perm.mockReset();
  h.refusal.mockReset();
  h.link.mockReset();
  h.unlink.mockReset();
  h.refusal.mockResolvedValue(null);
  h.proposalStatus = "pending";
  h.updates = [];
});

describe("synap_project_use_workspace {remove:true}", () => {
  it("files a link DELETE with the same endpoint payload the add files", async () => {
    h.perm.mockResolvedValue({
      proposalId: "p-1",
      reviewUrl: "https://x/p-1",
    });
    const out = await call({
      projectId: PROJECT,
      workspaceId: WS,
      remove: true,
    });
    expect(out.status).toBe("proposed");
    const opts = h.perm.mock.calls[0]![0] as Record<string, any>;
    expect(opts.subjectType).toBe("link");
    expect(opts.action).toBe("delete");
    expect(opts.agentUserId).toBe(AGENT);
    expect(opts.data).toMatchObject({
      fromType: "project",
      fromId: PROJECT,
      toType: "workspace",
      toId: WS,
      linkType: "uses",
    });
    expect(h.unlink).not.toHaveBeenCalled();
    expect(h.link).not.toHaveBeenCalled();
  });

  it("a direct (auto) remove calls unlink, never the add", async () => {
    h.perm.mockResolvedValue({ allowed: true });
    h.unlink.mockResolvedValue({ unlinked: true, rows: 1 });
    const out = await call({
      projectId: PROJECT,
      workspaceId: WS,
      remove: true,
    });
    expect(out).toMatchObject({ status: "unlinked", removed: 1 });
    expect(h.unlink).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT,
      workspaceId: WS,
      userId: USER,
    });
    expect(h.link).not.toHaveBeenCalled();
  });

  it("the endpoint floor refuses before governance", async () => {
    h.refusal.mockResolvedValue({ status: 403, error: "Access denied" });
    const out = await call({
      projectId: PROJECT,
      workspaceId: WS,
      remove: true,
    });
    expect(out.error).toBe("Access denied");
    expect(h.perm).not.toHaveBeenCalled();
    expect(h.unlink).not.toHaveBeenCalled();
  });

  it("without remove, the add path is unchanged (link create)", async () => {
    h.perm.mockResolvedValue({ allowed: true });
    h.link.mockResolvedValue({ linked: true });
    const out = await call({ projectId: PROJECT, workspaceId: WS });
    expect(out.status).toBe("linked");
    expect((h.perm.mock.calls[0]![0] as { action: string }).action).toBe(
      "create"
    );
    expect(h.unlink).not.toHaveBeenCalled();
  });
});

describe("link/delete approval executor", () => {
  registerLinkExecutors();
  const exec = proposalExecRegistry.resolve("link/delete")!;
  const deps = {
    reportProposalOutcome: vi.fn(),
    emitProposalReviewed: vi.fn(),
  } as never;
  const run = (data: unknown, subjectUserId: string | null = USER) =>
    exec.execute({
      proposal: {
        id: "p-1",
        targetType: "link",
        targetId: PROJECT,
        proposalType: "delete",
        workspaceId: WS,
        sessionId: null,
        projectId: null,
        agentUserId: AGENT,
        subjectUserId,
        sourceMessageId: null,
        data,
      },
      payload: data as never,
      userId: APPROVER,
      input: { proposalId: "p-1" },
      ctx: {} as never,
      deps,
    } as never);
  const stored = {
    requestId: "r-1",
    targetType: "link",
    changeType: "delete",
    data: {
      fromType: "project",
      fromId: PROJECT,
      toType: "workspace",
      toId: WS,
      linkType: "uses",
    },
  };

  it("is registered under the exact key", () => {
    expect(exec).toBeDefined();
  });

  it("replays unlink floored on the SUBJECT user and reports the delete's rows", async () => {
    h.unlink.mockResolvedValue({ unlinked: true, rows: 1 });
    const res = await run(stored);
    expect(h.unlink).toHaveBeenCalledWith(expect.anything(), {
      projectId: PROJECT,
      workspaceId: WS,
      userId: USER,
    });
    expect(res).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 1, subject: "link" },
    });
    expect(h.updates).toHaveLength(1);
  });

  it("refuses a link shape no governed door files", async () => {
    await expect(
      run({ ...stored, data: { ...stored.data, linkType: "targets" } })
    ).rejects.toThrow(/only a project --uses--> workspace/);
    expect(h.unlink).not.toHaveBeenCalled();
  });

  it("refuses a proposal with no owner, and a project the owner can no longer see", async () => {
    await expect(run(stored, null)).rejects.toThrow(/no owner/);
    h.unlink.mockResolvedValue({
      unlinked: false,
      reason: "project_not_found",
    });
    await expect(run(stored)).rejects.toThrow(/no longer/);
    expect(h.updates).toHaveLength(0);
  });
});
