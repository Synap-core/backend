/**
 * governanceRules.retroImpact for a "Never" draft (`verdict: "deny"`): a deny
 * refuses every matched act at the door, so a matched proposal flips unless a
 * person already rejected it. Driven through the real router and the real
 * matcher (`draftRuleMatchesWrite`); only the proposal read is stubbed.
 */

import { describe, it, expect, vi } from "vitest";

const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";
const WS = "11111111-1111-4111-8111-111111111111";

const ROWS = [
  { status: "auto_approved", agentUserId: AGENT },
  { status: "pending", agentUserId: AGENT },
  { status: "approved", agentUserId: AGENT },
  { status: "rejected", agentUserId: AGENT },
  { status: "rejected", agentUserId: AGENT },
  // Another agent's write: the agent-principal draft does not match it.
  { status: "auto_approved", agentUserId: OTHER_AGENT },
].map((r) => ({
  targetType: "entity",
  proposalType: "update",
  data: {},
  workspaceId: WS,
  ...r,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => ROWS }),
          }),
        }),
      }),
    },
  };
});

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { governanceRulesRouter } from "./governance-rules.js";
import type { Context } from "../types/context.js";

const caller = governanceRulesRouter.createCaller({
  authenticated: true,
  userId: "user-owner",
  workspaceId: WS,
} as unknown as Context);

const DRAFT = {
  principalKind: "agent" as const,
  agentUserId: AGENT,
  scopeKind: "pod" as const,
  targetKind: "action" as const,
  targetPattern: "entity.update",
};

describe("governanceRules.retroImpact", () => {
  it("a Never draft flips every matched proposal a person did not reject", async () => {
    const out = await caller.retroImpact({ ...DRAFT, verdict: "deny" });
    expect(out).toMatchObject({ matched: 5, wouldFlip: 3, sampled: 6 });
    expect(out.scope).toMatch(/did not reject/);
  });

  it("control: an ask-first draft flips only the auto-approved one", async () => {
    const out = await caller.retroImpact({ ...DRAFT, verdict: "propose" });
    expect(out).toMatchObject({ matched: 5, wouldFlip: 1 });
  });

  it("control: an always draft flips every matched one that went to review", async () => {
    const out = await caller.retroImpact({ ...DRAFT, verdict: "auto" });
    expect(out).toMatchObject({ matched: 5, wouldFlip: 4 });
  });
});
