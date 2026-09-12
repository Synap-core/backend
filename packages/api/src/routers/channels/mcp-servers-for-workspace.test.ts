import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getMcpServersForWorkspace` — the chat path's MCP server list.
 *
 * Pins four behaviours, each of which failed silently before:
 *  1. POD-WIDE servers are included. The filter was `workspace_id = ws` only,
 *     so a pod-scoped capability install (which creates workspace_id NULL) never
 *     reached chat — while `mcp://` dispatch, which does include NULL, worked.
 *  2. One entry per slug; a workspace server beats a pod-wide one (the IS names
 *     tools `mcp_<slug>_<tool>`, so two would collide).
 *  3. Auth headers are resolved PER CALL and never cached, and the internal
 *     `auth` reference never leaves the function.
 *  4. A server whose auth cannot be resolved is SKIPPED, not sent without its
 *     header (which would only surface as an anonymous 401 inside the IS).
 *
 * Limitation, stated: (1) is asserted on the predicate handed to the query
 * builder (drizzle helpers are mocked), because this suite has no Postgres. It
 * proves `isNull(workspace_id)` is OR-ed in; it does not execute the SQL.
 * `external-dispatch.js` is fully mocked: it is only dynamic-imported, for one
 * name, and loading it for real pulls in the whole connector stack.
 */

const { mockFindMany, mockResolveAuth, mockOr, mockIsNull } = vi.hoisted(
  () => ({
    mockFindMany: vi.fn(),
    mockResolveAuth: vi.fn(),
    mockOr: vi.fn((...conds: unknown[]) => ({ or: conds })),
    mockIsNull: vi.fn((col: unknown) => ({ isNull: col })),
  })
);

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: { query: { mcpServers: { findMany: mockFindMany } } },
    or: mockOr,
    isNull: mockIsNull,
  };
});

vi.mock("../../connectors/external-dispatch.js", () => ({
  resolveMcpServerAuthHeader: mockResolveAuth,
}));

import { getMcpServersForWorkspace, mcpServerCache } from "./helpers.js";
import { mcpServers } from "@synap/database/schema";

function row(over: Record<string, unknown>) {
  return {
    slug: "srv",
    name: "Server",
    workspaceId: null,
    transport: "http",
    command: null,
    args: [],
    url: "https://example.test/mcp",
    env: {},
    enabled: true,
    approved: true,
    toolPolicy: null,
    auth: null,
    ...over,
  };
}

const ACTOR = { userId: "user-1", agentUserId: "agent-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mcpServerCache.clear();
});

describe("getMcpServersForWorkspace", () => {
  it("OR-s pod-wide servers (workspace_id IS NULL) into the query", async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await getMcpServersForWorkspace("ws-1", ACTOR);
    expect(mockIsNull).toHaveBeenCalledWith(mcpServers.workspaceId);
    const isNullResult = mockIsNull.mock.results[0]!.value;
    expect(mockOr.mock.calls.some((c) => c.includes(isNullResult))).toBe(true);
  });

  it("keeps one entry per slug and prefers the WORKSPACE server", async () => {
    mockFindMany.mockResolvedValueOnce([
      row({ name: "pod-wide", workspaceId: null }),
      row({ name: "workspace", workspaceId: "ws-1" }),
    ]);
    const out = await getMcpServersForWorkspace("ws-1", ACTOR);
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("workspace");
  });

  it("prefers the workspace server regardless of row order", async () => {
    // The discriminating order: a "last one wins" dedupe passes the case above
    // and fails this one.
    mockFindMany.mockResolvedValueOnce([
      row({ name: "workspace", workspaceId: "ws-1" }),
      row({ name: "pod-wide", workspaceId: null }),
    ]);
    const out = await getMcpServersForWorkspace("ws-1", ACTOR);
    expect(out.map((s) => s.name)).toEqual(["workspace"]);
  });

  it("carries toolPolicy, attaches resolved headers, and never leaks `auth`", async () => {
    mockFindMany.mockResolvedValueOnce([
      row({
        toolPolicy: { default: "governed", inline: ["list_models"] },
        auth: {
          credentialRef: "vault://v1",
          header: "Authorization",
          prefix: "Bearer ",
        },
      }),
    ]);
    mockResolveAuth.mockResolvedValueOnce({
      ok: true,
      headers: { Authorization: "Bearer k" },
    });
    const [s] = await getMcpServersForWorkspace("ws-1", ACTOR);
    expect(s!.headers).toEqual({ Authorization: "Bearer k" });
    expect(s!.toolPolicy).toEqual({
      default: "governed",
      inline: ["list_models"],
    });
    expect(s).not.toHaveProperty("auth");
    expect(mockResolveAuth).toHaveBeenCalledWith(
      {
        credentialRef: "vault://v1",
        header: "Authorization",
        prefix: "Bearer ",
      },
      { userId: "user-1", agentUserId: "agent-1", workspaceId: "ws-1" }
    );
  });

  it("resolves the secret on EVERY call, even when the server list is cached", async () => {
    mockFindMany.mockResolvedValue([
      row({ auth: { credentialRef: "vault://v1", header: "Authorization" } }),
    ]);
    mockResolveAuth.mockResolvedValue({
      ok: true,
      headers: { Authorization: "k" },
    });
    await getMcpServersForWorkspace("ws-1", ACTOR);
    await getMcpServersForWorkspace("ws-1", ACTOR);
    expect(mockFindMany).toHaveBeenCalledTimes(1); // the list IS cached
    expect(mockResolveAuth).toHaveBeenCalledTimes(2); // the secret is NOT
  });

  it("skips an auth server when its credential cannot be resolved", async () => {
    mockFindMany.mockResolvedValueOnce([
      row({
        slug: "needs-auth",
        auth: { credentialRef: "vault://v1", header: "Authorization" },
      }),
      row({ slug: "open" }),
    ]);
    mockResolveAuth.mockResolvedValueOnce({ ok: false, error: "no grant" });
    const out = await getMcpServersForWorkspace("ws-1", ACTOR);
    expect(out.map((s) => s.id)).toEqual(["open"]);
  });

  it("skips an auth server when no actor is supplied to redeem its key", async () => {
    mockFindMany.mockResolvedValueOnce([
      row({
        slug: "needs-auth",
        auth: { credentialRef: "vault://v1", header: "Authorization" },
      }),
      row({ slug: "open" }),
    ]);
    const out = await getMcpServersForWorkspace("ws-1");
    expect(out.map((s) => s.id)).toEqual(["open"]);
    expect(mockResolveAuth).not.toHaveBeenCalled();
  });
});
