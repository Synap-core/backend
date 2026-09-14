/**
 * GET /briefs resolves a list-actions `verbId` to a brief, through the real
 * route → real runnable-action projection → real composer. Live 2026-09-14 the
 * Raycast get-action-brief tool passed `tools=entity.query,entity.delete` and got
 * `{}` every time: briefs were keyed only by MCP `synap_*` names.
 *
 * Mocked: the database (membership + an empty teaching-skill read) and the
 * registry READ. The projection, `runPosture` and the composer are real.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WS = "0aaaaaaa-0000-4000-8000-000000000001";
const HUMAN = "0bbbbbbb-0000-4000-8000-000000000002";

const { listCapabilities } = vi.hoisted(() => ({ listCapabilities: vi.fn() }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: vi.fn(async () => ({
      query: {
        workspaceMembers: { findFirst: vi.fn(async () => ({ role: "owner" })) },
      },
    })),
    db: {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      })),
    },
    ProfileResolutionService: class {
      async getEffectiveAiPosture() {
        return {};
      }
    },
  };
});

vi.mock("@synap/database/agent-governance", () => ({
  dryRunAgentGovernanceDecision: vi.fn(),
}));

vi.mock("../../../services/capabilities/capability-registry.js", () => ({
  listCapabilities,
}));

const { registerBriefsRoutes } = await import("./briefs.js");

function builtinSkill(name: string) {
  return {
    kind: "skill",
    id: `skill-${name}`,
    name,
    inputSchema: {},
    executor: "is-agent",
    governance: "none", // not read: approval is `enabled`
    enabled: true,
    skillKind: "builtin",
    skillMetadata: null,
    runnable: true,
  };
}

function makeApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    c.set("userId" as never, HUMAN as never);
    await next();
  });
  registerBriefsRoutes(app as never);
  return app;
}

const getBriefs = (tools: string) =>
  makeApp().request(
    `/briefs?tools=${encodeURIComponent(tools)}&workspaceId=${WS}&door=chat`
  );

beforeEach(() => {
  listCapabilities.mockReset();
  listCapabilities.mockResolvedValue([
    builtinSkill("entity.query"),
    builtinSkill("entity.delete"),
  ]);
});

describe("GET /briefs — list-actions verbIds", () => {
  it("entity.query resolves by verbId with the actions door's posture; a write states it proposes; a miss is omitted", async () => {
    const res = await getBriefs("entity.query,entity.delete,no.such_verb");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { briefs: Record<string, string> };
    expect(body.briefs["entity.query"]).toContain("runs directly");
    expect(body.briefs["entity.delete"]).toContain("PROPOSAL");
    // A miss stays a miss — Raycast turns an empty brief into found:false.
    expect(body.briefs).not.toHaveProperty("no.such_verb");
    expect(listCapabilities).toHaveBeenCalledWith({
      workspaceId: WS,
      userId: HUMAN,
    });
  });

  it("a failed registry read is a 500, never an empty brief", async () => {
    listCapabilities.mockRejectedValueOnce(new Error("registry down"));
    const res = await getBriefs("entity.query");
    expect(res.status).toBe(500);
  });
});
