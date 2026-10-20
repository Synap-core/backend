/**
 * Approval is the HUMAN step. `/skills/:id/approve` and `/tools/:id/approve`
 * turn a verb / an egress tool ON — the owner's OK that an agent-authored
 * skill may run or load. An agent key is remapped to its human owner
 * (`userId` = the human, `agentUserId` = the agent), and the doors rebuilt a
 * caller context from `userId` alone, so the owner-role check inside passed
 * and an agent could approve its OWN draft skill.
 *
 * Two layers, each tried here on its own:
 *  - the Hub REST doors refuse an agent caller (an agent key, or the IS's
 *    internal key — `isAgentCaller`) BEFORE anything is read;
 *  - the canonical procedures (`setSkillApproved`, `tools.setApproved`)
 *    refuse an acting agent from the server-side ALS every key door enters
 *    (`runWithActingAgent`), so the tRPC / any future door is floored too.
 *
 * The database is a probe: a refused request provably never read a row.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reached } = vi.hoisted(() => ({ reached: vi.fn() }));

const probe = (name: string): unknown =>
  new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      reached(`${name}.${String(prop)}`);
      throw new Error(`reached ${name}.${String(prop)}`);
    },
    apply: () => {
      reached(name);
      throw new Error(`reached ${name}()`);
    },
  });

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: probe("db") };
});
// The tRPC read-only-pod guard reads pod state; not what is under test.
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));
vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHubProtocolCallerContext: probe("createHubProtocolCallerContext"),
}));

const { runWithActingAgent } = await import("@synap/database");
const { registerSkillsCrudRoutes } = await import("./skills-crud.js");
const { registerToolsRoutes } = await import("./tools.js");
const { setSkillApproved } =
  await import("../../../services/capabilities/set-skill-approved.js");
const { toolsRouter } = await import("../../tools.js");
import type { HubHono, HubVariables } from "./_shared.js";

const ID = "00000000-0000-4000-8000-000000000001";
const HUMAN = "human-1";
const AGENT = "agent-1";

type Who = { agentUserId?: string; keyType?: string };

const DOORS = [
  { door: "skills", register: registerSkillsCrudRoutes },
  { door: "tools", register: registerToolsRoutes },
] as const;

function approve(door: (typeof DOORS)[number], who: Who) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", HUMAN);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (who.agentUserId) c.set("agentUserId", who.agentUserId);
    if (who.keyType) c.set("keyType", who.keyType as never);
    await next();
  });
  door.register(app);
  return app.request(`/${door.door}/${ID}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: true }),
  });
}

beforeEach(() => reached.mockClear());

describe("Hub REST approve doors refuse an agent caller", () => {
  it.each(DOORS)("$door: an agent key → 403, nothing read", async (door) => {
    const res = await approve(door, { agentUserId: AGENT });
    expect(res.status).toBe(403);
    expect(reached).not.toHaveBeenCalled();
  });

  it.each(DOORS)(
    "$door: the IS internal key → 403, nothing read",
    async (door) => {
      const res = await approve(door, { keyType: "is_internal" });
      expect(res.status).toBe(403);
      expect(reached).not.toHaveBeenCalled();
    }
  );

  it.each(DOORS)(
    "$door: CONTROL — a human passes the door (reaches the procedure)",
    async (door) => {
      const res = await approve(door, {});
      expect(res.status).not.toBe(403);
      expect(reached).toHaveBeenCalled();
    }
  );
});

describe("the canonical procedures refuse an acting agent", () => {
  it("setSkillApproved under an acting agent → FORBIDDEN, nothing read", async () => {
    await expect(
      runWithActingAgent(AGENT, () =>
        setSkillApproved({ userId: HUMAN, skillId: ID, approved: true })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reached).not.toHaveBeenCalled();
  });

  it("tools.setApproved under an acting agent → FORBIDDEN, nothing read", async () => {
    const caller = toolsRouter.createCaller({
      authenticated: true,
      userId: HUMAN,
    } as never);
    await expect(
      runWithActingAgent(AGENT, () =>
        caller.setApproved({ id: ID, approved: true })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reached).not.toHaveBeenCalled();
  });

  it("tools.setApproved with ctx.agentUserId → FORBIDDEN", async () => {
    const caller = toolsRouter.createCaller({
      authenticated: true,
      userId: HUMAN,
      agentUserId: AGENT,
    } as never);
    await expect(
      caller.setApproved({ id: ID, approved: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(reached).not.toHaveBeenCalled();
  });

  it("CONTROL — a human reaches the row lookup", async () => {
    await expect(
      setSkillApproved({ userId: HUMAN, skillId: ID, approved: true })
    ).rejects.toThrow(/reached db/);
    expect(reached).toHaveBeenCalled();
  });
});
