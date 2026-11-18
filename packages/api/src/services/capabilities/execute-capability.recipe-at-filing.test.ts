/**
 * Seam test: an agent's `computer.run_recipe` is planned when it is FILED,
 * through the real `executeCapability` propose branch (W3, D1 slice 1).
 *
 * MEASURED DEFECT (live pod, 10-11 Nov 2026): proposal 768f3e27 asked for the
 * recipe "range-cut", absent from the media-ffmpeg version the Mac had
 * approved; 3a1876af carried a value of the wrong type. Both were filed, the
 * founder approved them, and both failed after the yes (`approval_failed`),
 * because only the approval ran `queueRecipeRun`'s checks.
 *
 * The skill read and the gate are stubbed; `planRecipeRun` (the plan the
 * approval runs, proven on PGlite in `hosted-verbs.pglite.test.ts`) answers
 * what each case needs; the assertion is on what reaches
 * `createPendingProposal`, the row that would be inserted.
 *
 * NOT covered: the MCP / Hub wrappers' rendering of `kind:"deny"` (they
 * forward `reason` and `reasonCode`; see capability.ts / capabilities-execute.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const h = vi.hoisted(() => ({
  proposals: [] as Array<Record<string, unknown>>,
  planned: [] as Array<Record<string, unknown>>,
  plan: async (): Promise<unknown> => ({ ok: true, plan: {} }),
}));

const SKILL_ROW = {
  id: "skill-run-recipe",
  name: "computer.run_recipe",
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
    createPendingProposal: async (input: Record<string, unknown>) => {
      h.proposals.push(input);
      return { id: `prop-${h.proposals.length}` };
    },
  };
});

vi.mock("../host-jobs/hosted-verbs.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    planRecipeRun: async (input: Record<string, unknown>) => {
      h.planned.push(input);
      return h.plan();
    },
  };
});

const { executeCapability } = await import("./execute-capability.js");

const RANGE_CUT = {
  capability: "media-ffmpeg",
  recipe: "range-cut",
  params: { start: "0", end: 7 },
};

const fileIt = (parameters: Record<string, unknown> = RANGE_CUT) =>
  executeCapability({
    verbId: "computer.run_recipe",
    parameters,
    workspaceId: WS,
    userId: "user-1",
    agentUserId: "agent-1",
  });

/** The approval's sentence for 768f3e27 (`planRecipeRun`, UNKNOWN_RECIPE). */
const UNKNOWN =
  'media-ffmpeg on MacBook-Pro: its approved version has no recipe "range-cut", the pod\'s current one has it. Ask for the update (synap_request_installation, action "update") and approve it. Its recipes: loudness-normalize.';

describe("executeCapability: a recipe run that cannot apply is refused when it is filed", () => {
  beforeEach(() => {
    h.proposals.length = 0;
    h.planned.length = 0;
    h.plan = async () => ({ ok: true, plan: {} });
  });

  it("THE FILED CASE 768f3e27: a recipe absent from the approved version is refused with its code and fix, NO proposal", async () => {
    h.plan = async () => ({
      ok: false,
      code: "UNKNOWN_RECIPE",
      error: UNKNOWN,
    });
    const out = await fileIt();
    expect(out).toEqual({
      kind: "deny",
      reason: UNKNOWN,
      reasonCode: "UNKNOWN_RECIPE",
    });
    expect(h.proposals).toHaveLength(0);
    // The plan read the run as the approval reads it: the person, the space,
    // the tool, the recipe, the values as sent.
    expect(h.planned).toEqual([
      expect.objectContaining({
        userId: "user-1",
        workspaceId: WS,
        capabilityKey: "media-ffmpeg",
        recipe: "range-cut",
        values: { start: "0", end: 7 },
        computer: null,
      }),
    ]);
  });

  it("a value that does not fill the recipe (3a1876af) is refused, NO proposal", async () => {
    h.plan = async () => ({
      ok: false,
      code: "BAD_PARAMS",
      error: "end must be a string",
    });
    const out = await fileIt();
    expect(out).toMatchObject({ kind: "deny", reasonCode: "BAD_PARAMS" });
    expect(h.proposals).toHaveLength(0);
  });

  it("a computer not ready now is filed as before: the person may repair it first", async () => {
    h.plan = async () => ({
      ok: false,
      code: "NOT_RUNNABLE",
      error: "media-ffmpeg cannot run on MacBook-Pro: offline.",
    });
    expect(await fileIt()).toMatchObject({ kind: "proposed" });
    expect(h.proposals).toHaveLength(1);
  });

  it("a read that FAILS at filing files as before: never refused on a fact not read", async () => {
    h.plan = async () => {
      throw new Error("connection terminated");
    };
    expect(await fileIt()).toMatchObject({ kind: "proposed" });
    expect(h.proposals).toHaveLength(1);
    expect(h.planned).toHaveLength(1);
  });

  it("a run that can apply is filed, its payload intact", async () => {
    const out = await fileIt();
    expect(out).toMatchObject({ kind: "proposed" });
    expect(h.proposals).toHaveLength(1);
    expect(
      (h.proposals[0]!.data as { parameters: unknown }).parameters
    ).toEqual(RANGE_CUT);
  });
});
