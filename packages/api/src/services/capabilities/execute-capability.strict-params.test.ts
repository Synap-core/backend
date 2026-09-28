/**
 * Seam test — a builtin verb whose schema is `.strict()` refuses an
 * undeclared key at PROPOSE time, through the real `executeCapability`.
 *
 * MEASURED DEFECT (live pod, 2026-09-28): `run_capability playbook.update
 * {playbookId, params:[{key:"task",…}]}` — `params` was not a field of the
 * strict `playbookUpdateParams` then — was filed as proposal 612cb32d. The
 * founder approved it and it died `approval_failed` "internal error": the
 * handler's own `.parse()` ran only on approval. The propose-time check
 * (`validate-verb-parameters.ts`) skipped Zod's `unrecognized_keys` issue
 * because it names no field path, and answered "unvalidated".
 *
 * Drives the real propose branch with the skill read + gate stubbed and
 * asserts on what reaches `createPendingProposal` — the row that would be
 * inserted.
 *
 * NOT covered: the MCP / Hub wrappers' rendering of `kind:"error"` (they
 * forward `repair` verbatim; see capability.ts / capabilities-execute.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const proposals: any[] = [];

const SKILL_ROW = {
  id: "skill-pb-update",
  name: "playbook.update",
  approved: true,
  userId: "user-1",
  kind: "builtin",
  providerSpec: null,
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [SKILL_ROW] }),
          }),
        }),
      }),
    },
  };
});

vi.mock("./gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({
    decision: "propose",
    proposalType: "capability.run",
    data: {},
  }),
  CAPABILITY_RUN_PROPOSAL: {
    targetType: "capability",
    proposalType: "capability.run",
  },
}));

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createPendingProposal: async (input: any) => {
      proposals.push(input);
      return { id: `prop-${proposals.length}` };
    },
  };
});

const { executeCapability } = await import("./execute-capability.js");

const run = (parameters: Record<string, unknown>) =>
  executeCapability({
    verbId: "playbook.update",
    parameters,
    workspaceId: WS,
    userId: "user-1",
    agentUserId: "agent-1",
  });

describe("executeCapability — a strict builtin schema is enforced BEFORE a proposal", () => {
  beforeEach(() => {
    proposals.length = 0;
  });

  it("an undeclared key on a strict verb is refused and files NO proposal", async () => {
    const out = (await run({ playbookId: PB, owner: "me" })) as {
      kind: string;
      message?: string;
      repair?: { unrecognized?: string[] };
    };
    expect(out.kind).toBe("error");
    expect(out.repair?.unrecognized).toEqual(["owner"]);
    expect(out.message).toContain("owner");
    expect(out.message).toContain("Nothing was proposed");
    expect(proposals).toHaveLength(0);
  });

  it("THE FILED CASE: params entries keyed `key` are refused with the fix, NO proposal", async () => {
    const out = (await run({
      playbookId: PB,
      params: [{ key: "task", type: "text", required: true }],
    })) as { kind: string; message?: string };
    expect(out.kind).toBe("error");
    expect(out.message).toContain('needs "name" (got "key": "task")');
    expect(proposals).toHaveLength(0);
  });

  it("the corrected call — params by name + goal rewritten to {task} — IS proposed, payload intact", async () => {
    const parameters = {
      playbookId: PB,
      params: [{ name: "task", type: "text", required: true }],
      goalTemplate: 'Run the dev task "{task}" as a staged work session',
    };
    const out = await run(parameters);
    expect(out.kind).toBe("proposed");
    expect(proposals).toHaveLength(1);
    expect(proposals[0].data.parameters).toEqual(parameters);
  });
});
