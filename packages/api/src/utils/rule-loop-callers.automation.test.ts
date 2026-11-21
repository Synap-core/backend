/**
 * The batch's automation caller hands the door the status the op asked for
 * only when a person approved the batch; a batch no person reviewed (a direct
 * capture, an import) writes drafts whatever its ops say.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<Record<string, unknown>> = [];
vi.mock("../routers/automations.js", () => ({
  materializeAutomationForPrincipal: async (args: Record<string, unknown>) => {
    calls.push(args);
    return "auto-1";
  },
}));

const { buildRuleLoopCallers } = await import("./rule-loop-callers.js");

function callerFor(personApproved: boolean) {
  return buildRuleLoopCallers({
    database: {} as never,
    userId: "person-1",
    workspaceId: "ws-1",
    auditSource: "test",
    skillAuthor: { agentUserId: null, personApproved },
  }).automationCaller;
}

const op = {
  name: "Weekly recap",
  triggerType: "manual" as const,
  flowDefinition: { nodes: [], edges: [] },
};

const statusOfLastCall = () =>
  (calls.at(-1)!.definition as { status?: string }).status;

beforeEach(() => {
  calls.length = 0;
});

describe("rule-loop automation caller", () => {
  it("a batch no person reviewed writes a draft, even when the op asks enabled", async () => {
    await callerFor(false).create({ ...op, enabled: true });
    expect(statusOfLastCall()).toBe("draft");
    expect(calls.at(-1)).toMatchObject({ personApproved: false });
  });

  it("a person's approval hands the asked status to the door, none when none was asked", async () => {
    await callerFor(true).create({ ...op, enabled: true });
    expect(statusOfLastCall()).toBe("active");
    await callerFor(true).create(op);
    expect(statusOfLastCall()).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ personApproved: true });
  });
});
