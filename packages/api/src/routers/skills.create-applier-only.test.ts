/**
 * `skills.create` — `urlPatterns` (which kept links a reader verb receives)
 * and `intent` (what a verb means) are written by ONE caller: the
 * capability-definition applier, which marks its caller context with
 * `SKILL_DEFINITION_APPLIER`. Any other caller (a member over tRPC, Hub REST,
 * MCP) naming either is FORBIDDEN before the governance gate runs; the
 * applier's patterns reach the gate's stored data (reachability, not shape).
 *
 * Stubbed: the read-only / audit middlewares and the governance gate (returns `proposed`, so no DB insert runs) —
 * the gate's own suites cover it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ gated: [] as Array<Record<string, unknown>> }));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (args: { data: Record<string, unknown> }) => {
    h.gated.push(args.data);
    return { proposalId: "proposal-1" };
  },
  createPendingProposal: async () => ({ proposalId: "proposal-1" }),
}));

import { skillsRouter, SKILL_DEFINITION_APPLIER } from "./skills.js";

const base = { authenticated: true, userId: "user-1", workspaceId: null };
const member = () => skillsRouter.createCaller(base as never);
const applier = () =>
  skillsRouter.createCaller({
    ...base,
    [SKILL_DEFINITION_APPLIER]: true,
  } as never);

const SKILL = {
  name: "read_instagram",
  kind: "code" as const,
  code: "return { ok: true };",
};

beforeEach(() => {
  h.gated.length = 0;
});

describe("skills.create: urlPatterns and intent are the applier's alone", () => {
  it("a member naming urlPatterns is FORBIDDEN before the gate", async () => {
    await expect(
      member().create({ ...SKILL, urlPatterns: ["instagram.com/p/*"] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      member().create({ ...SKILL, intent: "read_webpage" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.gated).toEqual([]);
  });

  it("a context claiming the marker by STRING key is still a member", async () => {
    await expect(
      skillsRouter
        .createCaller({
          ...base,
          [String(SKILL_DEFINITION_APPLIER)]: true,
          definitionApplier: true,
        } as never)
        .create({ ...SKILL, urlPatterns: ["*"] })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a member's plain create still reaches the gate", async () => {
    expect(await member().create(SKILL)).toMatchObject({
      status: "proposed",
    });
    expect(h.gated).toHaveLength(1);
    expect(h.gated[0]).not.toHaveProperty("urlPatterns");
  });

  it("the applier's patterns and intent reach the gate's stored data", async () => {
    await applier().create({
      ...SKILL,
      intent: "read_webpage",
      urlPatterns: ["instagram.com/p/*"],
    });
    expect(h.gated[0]).toMatchObject({
      intent: "read_webpage",
      urlPatterns: ["instagram.com/p/*"],
    });
  });
});
