/**
 * `tools.setAuthBinding` — binding a credential to a tool is governed (CP
 * ticket 7c01a8b7). The owner-role check passes for an AGENT key linked to an
 * owner, so the door must route through `checkPermissionOrPropose`: an agent
 * proposes and nothing is bound; a person binds and an audit row is written.
 *
 * The governance gate is stubbed (its verdicts are pinned by its own suites);
 * what is under test is that the door CONSULTS it and honours its verdict.
 * Both Hub REST (`POST /tools/:id/auth-binding`) and tRPC reach this one
 * procedure — the structural test at the bottom pins that the REST door holds
 * no write of its own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const h = vi.hoisted(() => ({
  verdict: {} as Record<string, unknown>,
  gated: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (args: Record<string, unknown>) => {
    h.gated.push(args);
    return h.verdict;
  },
}));
vi.mock("../utils/audit-log.js", () => ({
  auditLog: (a: Record<string, unknown>) => h.audits.push(a),
}));
vi.mock("../utils/workspace-role.js", () => ({
  getWorkspaceRole: async () => "owner",
  requirePodAdmin: async () => undefined,
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  db: {
    query: {
      tools: {
        findFirst: async () => ({
          id: "00000000-0000-4000-8000-000000000001",
          workspaceId: "ws-1",
          authBinding: "static",
          metadata: {},
        }),
      },
    },
    update: () => ({
      set: (v: Record<string, unknown>) => {
        h.updates.push(v);
        return { where: () => ({ returning: async () => [{ ...v }] }) };
      },
    }),
  },
}));

import { toolsRouter } from "./tools.js";

const ID = "00000000-0000-4000-8000-000000000001";
const caller = () =>
  toolsRouter.createCaller({
    authenticated: true,
    userId: "owner-1",
    agentUserId: "agent-1",
  } as never);

beforeEach(() => {
  h.gated.length = 0;
  h.updates.length = 0;
  h.audits.length = 0;
});

describe("tools.setAuthBinding is governed", () => {
  it("an agent caller gets `proposed` and nothing is bound", async () => {
    h.verdict = { proposalId: "proposal-1" };
    const res = await caller().setAuthBinding({
      id: ID,
      authBinding: "per_entity",
    });
    expect(res).toMatchObject({ status: "proposed", proposalId: "proposal-1" });
    expect(h.gated).toHaveLength(1);
    expect(h.gated[0]).toMatchObject({
      subjectType: "tool",
      action: "setAuthBinding",
      data: { id: ID, authBinding: "per_entity" },
    });
    expect(h.updates).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("a denied caller is refused and nothing is bound", async () => {
    h.verdict = { denied: true, reason: "no" };
    await expect(
      caller().setAuthBinding({ id: ID, authBinding: "per_user" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.updates).toHaveLength(0);
  });

  it("a person is granted: the binding is written, approval reset, audit row written", async () => {
    h.verdict = { granted: true };
    const res = await caller().setAuthBinding({
      id: ID,
      authBinding: "per_entity",
    });
    expect(res).toMatchObject({ status: "updated", proposalId: null });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      authBinding: "per_entity",
      approved: false,
    });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      subjectType: "tool",
      action: "setAuthBinding",
      subjectId: ID,
      userId: "owner-1",
      data: { from: "static", to: "per_entity" },
    });
  });
});

describe("one door", () => {
  it("the Hub REST route replays the procedure and writes nothing itself", () => {
    const src = readFileSync(
      join(process.cwd(), "src/routers/hub-protocol/rest/tools.ts"),
      "utf8"
    );
    const start = src.indexOf('app.post("/tools/:id/auth-binding"');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("app.get(", start);
    const body = src.slice(start, end);
    expect(body).toContain("caller.setAuthBinding(");
    expect(body).not.toMatch(/\.update\(tools\)|db\.update/);
  });
});
