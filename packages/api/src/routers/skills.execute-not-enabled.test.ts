/**
 * Seam test — `skills.execute` (the operator door; no agent identity reaches
 * it) on a not-enabled skill: nothing runs, and the refusal says so with the
 * Settings pointer instead of the gate's agent-addressed text ("Ask the user
 * to enable it … or run with dryRun").
 */

import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const runSkill = vi.fn();

vi.mock("../services/capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({
    decision: "deny",
    reason:
      "This capability is installed but not yet enabled. Ask the user to enable it (Tools), or run with dryRun to preview.",
  }),
}));
// The one skill door (R2): a refused run must never reach it.
vi.mock("../services/skills/run-skill.js", () => ({ runSkill }));
// protectedProcedure's DB-backed middlewares (split-brain read-only guard, audit
// log) are not what this seam is about — pass through.
vi.mock("../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

const { skillsRouter } = await import("./skills.js");

const SKILL = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "source-triage",
  status: "active",
  approved: false,
  scope: "pod",
  userId: "owner-1",
  workspaceId: null,
};

describe("skills.execute — not-enabled skill", () => {
  it("refuses with 'Nothing ran' + Settings, and never reaches the skill door", async () => {
    const caller = skillsRouter.createCaller({
      authenticated: true,
      userId: "owner-1",
      db: { query: { skills: { findFirst: async () => SKILL } } },
    } as never);
    const err = await caller.execute({ id: SKILL.id }).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code, String(err.message)).toBe("FORBIDDEN");
    expect(err.message).toBe(
      'Nothing ran: "source-triage" is installed but not enabled. Enable it in Tools, then run it again.'
    );
    expect(runSkill).not.toHaveBeenCalled();
  });
});
