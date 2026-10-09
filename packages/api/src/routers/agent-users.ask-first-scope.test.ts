/**
 * "Its writes" SCOPE (founder decision 2026-10-08) — the SEAM of
 * `agentUsers.update({ askFirst })` and the `postures` read.
 *
 * `askFirst` moves the ask-first posture to EXACTLY one scope (pod, or one
 * space) through THE posture writer, clearing it from every other scope; every
 * space it writes or clears passes the Rules editor's gate
 * (`assertCanManageRule`) BEFORE any write. The decision half (a space posture
 * proposes in that space only) is pinned on real Postgres in @synap/database
 * `agent-posture-scope.pglite.test.ts`.
 *
 * NOT covered here: `assertCanManageRule`'s own role/ownership logic (mocked —
 * it is the Rules editor's gate, exercised by its own router tests).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SALES = "33333333-3333-4333-8333-333333333333";
const OPS = "44444444-4444-4444-8444-444444444444";
const LOCKED = "55555555-5555-4555-8555-555555555555";
const OWNER_ID = "user-owner";

type Scope = { kind: "pod" } | { kind: "workspace"; workspaceId: string };

const h = vi.hoisted(() => ({
  applied: [] as Array<{ posture: string | null; scope: unknown }>,
  checked: [] as string[],
  governance: {
    posture: null as string | null,
    writesRequireProposal: true,
    rules: [] as unknown[],
    spaces: [] as Array<{ workspaceId: string; posture: string | null }>,
    configured: false,
  },
  visibleSpaces: [] as Array<{ id: string; name: string }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    verifyPermission: async () => ({ allowed: true, role: "admin" }),
    readReversibleDefault: async () => ({ enabled: true, ruleId: "r1" }),
    db: {
      select: () => ({
        from: () => ({
          where: () => {
            // `governance` awaits the space-name read directly; `update`
            // loads the agent with `.limit(1)`.
            const rows = h.visibleSpaces;
            const p = Promise.resolve(rows) as Promise<unknown[]> & {
              limit: () => Promise<unknown[]>;
            };
            p.limit = async () => [
              { id: AGENT_ID, userType: "agent", agentMetadata: {} },
            ];
            return p;
          },
        }),
      }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    },
  };
});

vi.mock("@synap/database/agent-governance", () => ({
  applyAgentPosture: async (input: {
    posture: string | null;
    scope?: Scope;
  }) => {
    h.applied.push({ posture: input.posture, scope: input.scope });
    return { posture: input.posture, writesRequireProposal: true };
  },
  readAgentGovernance: async () => h.governance,
}));

vi.mock("./governance-rules.js", () => ({
  assertCanManageRule: async (
    _userId: string,
    rule: { workspaceId?: string | null }
  ) => {
    h.checked.push(rule.workspaceId ?? "");
    if (rule.workspaceId === LOCKED)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Editor role or higher required for this workspace",
      });
  },
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => {} }));

import { agentUsersRouter } from "./agent-users.js";
import type { Context } from "../types/context.js";

const caller = () =>
  agentUsersRouter.createCaller({
    authenticated: true,
    userId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
  } as unknown as Context);

const update = (askFirst: null | Scope) =>
  caller().update({
    workspaceId: WORKSPACE_ID,
    agentUserId: AGENT_ID,
    askFirst,
  });

beforeEach(() => {
  h.applied.length = 0;
  h.checked.length = 0;
  h.visibleSpaces = [];
  h.governance = {
    posture: null,
    writesRequireProposal: true,
    rules: [],
    spaces: [],
    configured: false,
  };
});

describe("agentUsers.update({ askFirst }) — one scope, exclusively", () => {
  it("pod: writes the pod posture and clears a space ask-first", async () => {
    h.governance.spaces = [{ workspaceId: SALES, posture: "ask-first" }];
    await update({ kind: "pod" });
    expect(h.applied).toEqual([
      { posture: "ask-first", scope: { kind: "pod" } },
      { posture: null, scope: { kind: "workspace", workspaceId: SALES } },
    ]);
    expect(h.checked).toEqual([SALES]);
  });

  it("a space: writes it there FIRST, then clears the pod ask-first", async () => {
    h.governance.posture = "ask-first";
    await update({ kind: "workspace", workspaceId: SALES });
    expect(h.applied).toEqual([
      {
        posture: "ask-first",
        scope: { kind: "workspace", workspaceId: SALES },
      },
      { posture: null, scope: { kind: "pod" } },
    ]);
    expect(h.checked).toEqual([SALES]);
  });

  it("null: clears every ask-first scope; another preset is left alone", async () => {
    h.governance.posture = "create-with-undo";
    h.governance.spaces = [
      { workspaceId: SALES, posture: "ask-first" },
      { workspaceId: OPS, posture: "create-with-undo" },
    ];
    await update(null);
    expect(h.applied).toEqual([
      { posture: null, scope: { kind: "workspace", workspaceId: SALES } },
    ]);
  });

  it("refuses a space the caller cannot manage — and writes NOTHING", async () => {
    h.governance.posture = "ask-first";
    await expect(
      update({ kind: "workspace", workspaceId: LOCKED })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.applied).toEqual([]);
  });

  it("refuses to clear a space the caller cannot manage — and writes NOTHING", async () => {
    h.governance.spaces = [{ workspaceId: LOCKED, posture: "ask-first" }];
    await expect(update({ kind: "pod" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(h.applied).toEqual([]);
  });

  it("askFirst and the legacy writesRequireProposal together are refused", async () => {
    await expect(
      caller().update({
        workspaceId: WORKSPACE_ID,
        agentUserId: AGENT_ID,
        askFirst: { kind: "pod" },
        writesRequireProposal: true,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.applied).toEqual([]);
  });
});

describe("agentUsers.governance — postures per scope", () => {
  it("reports the pod posture and each visible space with its name", async () => {
    h.governance.posture = null;
    h.governance.spaces = [
      { workspaceId: SALES, posture: "ask-first" },
      { workspaceId: LOCKED, posture: "ask-first" },
    ];
    h.visibleSpaces = [{ id: SALES, name: "Sales" }];
    const g = await caller().governance({ agentUserId: AGENT_ID });
    expect(g.askFirst).toBe(false);
    expect(g.postures).toEqual({
      pod: null,
      spaces: [{ workspaceId: SALES, name: "Sales", posture: "ask-first" }],
    });
  });
});
