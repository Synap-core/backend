/**
 * R8a — the workspace-ops doors, all three layers at their seams:
 *
 *   1. `workspace-ops-doors.ts` forwards to the GOVERNED router procedure with
 *      the acting AGENT on the caller context (drop it and the gate takes the
 *      human path and executes — the attribution trap), and derives a kind's
 *      home workspace for grant-access;
 *   2. the MCP tools call those doors (never a router directly);
 *   3. the Hub REST routes validate the wire shape and answer a proposal with
 *      202 (`jsonGoverned`).
 *
 * Routers are mocked; the procedures are pinned in their own tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ctxs: [] as Array<Record<string, unknown>>,
  archive: vi.fn(),
  update: vi.fn(),
  move: vi.fn(),
  grant: vi.fn(),
  homeWs: "33333333-3333-4333-8333-333333333333" as string | null,
}));

vi.mock("../routers/workspaces.js", () => ({
  workspacesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctxs.push(ctx);
      return { archive: h.archive, update: h.update };
    },
  },
}));
vi.mock("../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctxs.push(ctx);
      return { moveToWorkspace: h.move };
    },
  },
}));
vi.mock("../routers/profiles.js", () => ({
  profilesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.ctxs.push(ctx);
      return { grantAccess: h.grant };
    },
  },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({}),
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (h.homeWs ? [{ workspaceId: h.homeWs }] : []),
          }),
        }),
      }),
    },
  };
});

import {
  archiveWorkspaceDoor,
  grantProfileAccessDoor,
  moveEntitiesDoor,
  renameWorkspaceDoor,
} from "./workspace-ops-doors.js";
import { workspaceHandlers } from "../routers/mcp/handlers/workspace.js";
import type { McpToolContext } from "../routers/mcp/handlers/shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const WS_TO = "66666666-6666-4666-8666-666666666666";
const ENTITY = "77777777-7777-4777-8777-777777777777";
const PROFILE = "88888888-8888-4888-8888-888888888888";

const actor = {
  userId: USER,
  scopes: ["mcp.write"],
  agentUserId: AGENT,
  sessionId: null,
};

beforeEach(() => {
  for (const fn of [h.archive, h.update, h.move, h.grant]) fn.mockReset();
  h.ctxs = [];
  h.homeWs = WS;
});

describe("workspace-ops doors → governed procedures", () => {
  it("archive/restore forward to workspaces.archive with the acting agent", async () => {
    h.archive.mockResolvedValue({ status: "proposed", proposalId: "p" });
    const out = await archiveWorkspaceDoor(actor, {
      workspaceId: WS,
      restore: true,
      reasoning: "done with it",
    });
    expect(out).toEqual({ status: "proposed", proposalId: "p" });
    expect(h.archive).toHaveBeenCalledWith({
      workspaceId: WS,
      restore: true,
      reasoning: "done with it",
    });
    expect(h.ctxs[0]).toMatchObject({
      userId: USER,
      agentUserId: AGENT,
      workspaceId: WS,
    });
  });

  it("rename forwards name/description only, and refuses an empty patch", async () => {
    h.update.mockResolvedValue({ status: "updated" });
    await renameWorkspaceDoor(actor, { workspaceId: WS, name: "New" });
    expect(h.update).toHaveBeenCalledWith({ id: WS, name: "New" });
    await expect(
      renameWorkspaceDoor(actor, { workspaceId: WS })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("move forwards to entities.moveToWorkspace", async () => {
    h.move.mockResolvedValue({ moved: [ENTITY], proposed: [], errors: [] });
    await moveEntitiesDoor(actor, { entityIds: [ENTITY], workspaceId: WS_TO });
    expect(h.move).toHaveBeenCalledWith({
      entityIds: [ENTITY],
      workspaceId: WS_TO,
    });
    expect(h.ctxs[0]).toMatchObject({ agentUserId: AGENT });
  });

  it("grant-access acts in the kind's HOME workspace when none is given", async () => {
    h.grant.mockResolvedValue({ success: true, status: "granted" });
    await grantProfileAccessDoor(actor, {
      profileId: PROFILE,
      targetWorkspaceId: WS_TO,
    });
    expect(h.ctxs[0]).toMatchObject({ workspaceId: WS, agentUserId: AGENT });
    expect(h.grant).toHaveBeenCalledWith({
      profileId: PROFILE,
      targetWorkspaceId: WS_TO,
    });
    h.homeWs = null;
    await expect(
      grantProfileAccessDoor(actor, {
        profileId: PROFILE,
        targetWorkspaceId: WS_TO,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("MCP tools call the doors", () => {
  const call = async (tool: string, args: Record<string, unknown>) => {
    const res = await workspaceHandlers[tool]!({
      toolName: tool,
      args,
      userId: USER,
      apiKeyScopes: ["mcp.read", "mcp.write"],
      agentUserId: AGENT,
    } as unknown as McpToolContext);
    return JSON.parse((res.content as { text: string }[])[0]!.text) as Record<
      string,
      unknown
    >;
  };

  it("synap_archive_workspace", async () => {
    h.archive.mockResolvedValue({ status: "proposed", proposalId: "p" });
    expect(
      await call("synap_archive_workspace", { workspaceId: WS })
    ).toMatchObject({
      status: "proposed",
      proposalId: "p",
    });
    expect(h.ctxs[0]).toMatchObject({ agentUserId: AGENT });
    expect(await call("synap_archive_workspace", {})).toHaveProperty("error");
  });

  it("synap_update_workspace", async () => {
    h.update.mockResolvedValue({ status: "proposed", proposalId: "p" });
    await call("synap_update_workspace", { workspaceId: WS, name: "N" });
    expect(h.update).toHaveBeenCalledWith({ id: WS, name: "N" });
    expect(
      await call("synap_update_workspace", { workspaceId: WS })
    ).toHaveProperty("error");
  });

  it("synap_move_entities", async () => {
    h.move.mockResolvedValue({ moved: [], proposed: [], errors: [] });
    await call("synap_move_entities", {
      entityIds: [ENTITY],
      workspaceId: WS_TO,
      reasoning: "misrouted",
    });
    expect(h.move).toHaveBeenCalledWith({
      entityIds: [ENTITY],
      workspaceId: WS_TO,
      reason: "misrouted",
    });
  });

  it("synap_grant_profile_access", async () => {
    h.grant.mockResolvedValue({ success: false, status: "proposed" });
    await call("synap_grant_profile_access", {
      profileId: PROFILE,
      targetWorkspaceId: WS_TO,
    });
    expect(h.grant).toHaveBeenCalledWith({
      profileId: PROFILE,
      targetWorkspaceId: WS_TO,
    });
  });
});

describe("Hub REST routes", () => {
  async function app(agentUserId: string | undefined = AGENT) {
    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const { registerWorkspaceOpsRoutes } =
      await import("../routers/hub-protocol/rest/workspace-ops.js");
    const a = new OpenAPIHono();
    a.use("*", async (c, next) => {
      c.set("userId" as never, USER as never);
      c.set("scopes" as never, ["hub-protocol.write"] as never);
      if (agentUserId) c.set("agentUserId" as never, agentUserId as never);
      await next();
    });
    registerWorkspaceOpsRoutes(a as never);
    return a;
  }
  const send = async (method: string, path: string, body: unknown) =>
    (await app()).request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("POST /workspaces/:id/archive — a proposal is 202", async () => {
    h.archive.mockResolvedValue({ status: "proposed", proposalId: "p" });
    const res = await send("POST", `/workspaces/${WS}/archive`, {});
    expect(res.status).toBe(202);
    expect(h.archive).toHaveBeenCalledWith({ workspaceId: WS, restore: false });
  });

  it("POST /workspaces/:id/restore forces restore", async () => {
    h.archive.mockResolvedValue({ status: "restored", pausedByArchive: [] });
    const res = await send("POST", `/workspaces/${WS}/restore`, {});
    expect(res.status).toBe(200);
    expect(h.archive).toHaveBeenCalledWith({ workspaceId: WS, restore: true });
  });

  it("a non-uuid workspace id is a 400 that never reaches the door", async () => {
    const res = await send("POST", `/workspaces/nope/archive`, {});
    expect(res.status).toBe(400);
    expect(h.archive).not.toHaveBeenCalled();
  });

  it("PATCH /workspaces/:id renames", async () => {
    h.update.mockResolvedValue({ status: "updated" });
    const res = await send("PATCH", `/workspaces/${WS}`, { name: "N" });
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({ id: WS, name: "N" });
  });

  it("POST /entities/move validates ids", async () => {
    h.move.mockResolvedValue({ moved: [ENTITY], proposed: [], errors: [] });
    expect(
      (
        await send("POST", "/entities/move", {
          entityIds: ["x"],
          workspaceId: WS,
        })
      ).status
    ).toBe(400);
    const ok = await send("POST", "/entities/move", {
      entityIds: [ENTITY],
      workspaceId: WS_TO,
    });
    expect(ok.status).toBe(200);
  });

  it("POST /profiles/grant-access — proposal is 202", async () => {
    h.grant.mockResolvedValue({
      success: false,
      status: "proposed",
      proposalId: "p",
    });
    const res = await send("POST", "/profiles/grant-access", {
      profileId: PROFILE,
      targetWorkspaceId: WS_TO,
    });
    expect(res.status).toBe(202);
  });
});
