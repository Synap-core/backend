/**
 * The invariant this file exists for: TWO CONCURRENT SESSIONS IN ONE WORKSPACE
 * MUST NOT RESOLVE TO THE SAME CHECKOUT. The resolver used to be keyed on the
 * workspace alone, so they always did — two coding agents writing one tree,
 * which is how peer work has already been destroyed in this repo once.
 *
 * Behavioural, not structural: the tests drive the resolver through fixture
 * rows and assert the PATH it returns.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const sessionRows = new Map<string, Row>();
const workspaceRows = new Map<string, Row>();

vi.mock("@synap/database", () => ({
  // `eq(col, value)` — the mock only needs to carry the id through to findFirst.
  eq: (_col: unknown, value: string) => ({ __id: value }),
  db: {
    query: {
      focusSessions: {
        findFirst: async (args: { where: { __id: string } }) =>
          sessionRows.get(args.where.__id),
      },
      workspaces: {
        findFirst: async (args: { where: { __id: string } }) =>
          workspaceRows.get(args.where.__id),
      },
    },
  },
}));

vi.mock("@synap/database/schema", () => ({
  workspaces: { id: "workspaces.id" },
  focusSessions: { id: "focus_sessions.id" },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const { resolveDevCwd } = await import("./dev-cwd.js");

const WS = "ws-1";

beforeEach(() => {
  sessionRows.clear();
  workspaceRows.clear();
  workspaceRows.set(WS, {
    settings: { devplane: { workspacePath: "/repos/shared" } },
  });
});

describe("resolveDevCwd", () => {
  it("gives two sessions in the SAME workspace two DIFFERENT working trees", async () => {
    sessionRows.set("s-a", {
      workspaceId: WS,
      metadata: { devplane: { workspacePath: "/repos/wt-a" } },
    });
    sessionRows.set("s-b", {
      workspaceId: WS,
      metadata: { devplane: { workspacePath: "/repos/wt-b" } },
    });

    const a = await resolveDevCwd(WS, "s-a");
    const b = await resolveDevCwd(WS, "s-b");

    expect(a).toBe("/repos/wt-a");
    expect(b).toBe("/repos/wt-b");
    expect(a).not.toBe(b);
  });

  it("falls back to the workspace path when the session declares none", async () => {
    sessionRows.set("s-a", { workspaceId: WS, metadata: {} });

    await expect(resolveDevCwd(WS, "s-a")).resolves.toBe("/repos/shared");
  });

  it("keeps the pre-existing behaviour for a caller with no session", async () => {
    await expect(resolveDevCwd(WS)).resolves.toBe("/repos/shared");
    await expect(resolveDevCwd(WS, null)).resolves.toBe("/repos/shared");
  });

  it("falls back to the workspace path when the session row is missing", async () => {
    await expect(resolveDevCwd(WS, "does-not-exist")).resolves.toBe(
      "/repos/shared"
    );
  });

  it("ignores a blank session path rather than spawning in an empty string", async () => {
    sessionRows.set("s-a", {
      workspaceId: WS,
      metadata: { devplane: { workspacePath: "   " } },
    });

    await expect(resolveDevCwd(WS, "s-a")).resolves.toBe("/repos/shared");
  });

  it("refuses to let a session from ANOTHER workspace redirect the checkout", async () => {
    sessionRows.set("s-other", {
      workspaceId: "ws-2",
      metadata: { devplane: { workspacePath: "/repos/somebody-elses" } },
    });

    await expect(resolveDevCwd(WS, "s-other")).resolves.toBe("/repos/shared");
  });

  it("falls back to $HOME when neither session nor workspace declares a path", async () => {
    workspaceRows.set(WS, { settings: {} });
    process.env["HOME"] = "/home/tester";

    await expect(resolveDevCwd(WS)).resolves.toBe("/home/tester");
  });
});
