/**
 * The `project/create` executor replays an agent's proposed PLACE — colour,
 * icon, chosen home and used spaces — into the SAME `projects.create` the
 * direct path uses. A field the gate carries but the replay drops makes an
 * approved create land without it, silently (the executor's own docblock
 * names that defect: "an approved project no longer loses everything but its
 * name").
 *
 * Executes the REAL executor; only the db, the membership lookup and the
 * router it replays into are stubbed (the replay's own input is what is
 * asserted). An OLD proposal (name only) must still replay with none of them.
 *
 * A used space that does not link on the replay is a PARTIAL application: it
 * rides the result's `refusals` (places review S9), never a clean approval.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  creates: [] as Array<Record<string, unknown>>,
  /** What the replayed create answers. */
  answer: { status: "created", projectId: "p-1" } as Record<string, unknown>,
  /** Rows each successive `where` resolves (default: none). */
  rows: [] as unknown[][],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // select → from → where resolves no row (not yet approved); update chains.
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "from", "update", "set"]) chain[k] = () => chain;
  chain.where = async () => h.rows.shift() ?? [];
  return {
    ...actual,
    db: chain,
    getWorkspaceMembership: async () => ({ role: "owner" }),
  };
});
vi.mock("../../../projects.js", () => ({
  projectsRouter: {
    createCaller: () => ({
      create: async (input: Record<string, unknown>) => {
        h.creates.push(input);
        return h.answer;
      },
    }),
  },
}));
vi.mock("../../../../services/tracks/tracks-service.js", () => ({
  startTrack: vi.fn(),
}));

import { registerProjectExecutors } from "../project.js";
import { proposalExecRegistry } from "../../execution-registry.js";

const WA = "11111111-1111-4111-8111-111111111111";
const WB = "22222222-2222-4222-8222-222222222222";

async function approve(data: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolveExact("project/create")!;
  return executor.execute({
    proposal: { workspaceId: WA, data: { data } },
    userId: "u-1",
    input: { proposalId: "prop-1" },
    deps: {
      reportProposalOutcome: () => {},
      emitProposalReviewed: () => {},
    },
  } as never);
}

beforeEach(() => {
  h.creates.length = 0;
  h.answer = { status: "created", projectId: "p-1" };
  h.rows = [];
  proposalExecRegistry._reset();
  registerProjectExecutors();
});

describe("project/create replays the proposed place", () => {
  it("colour, icon, home and used spaces reach the replayed create", async () => {
    await approve({
      name: "Lyra",
      colorSlot: 5,
      icon: "🚀",
      homeWorkspaceId: WA,
      usedWorkspaceIds: [WA, WB],
    });
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0]).toMatchObject({
      name: "Lyra",
      colorSlot: 5,
      icon: "🚀",
      homeWorkspaceId: WA,
      usedWorkspaceIds: [WA, WB],
    });
  });

  it("an older proposal (name only) replays with none of them", async () => {
    await approve({ name: "Old" });
    expect(h.creates).toHaveLength(1);
    for (const k of [
      "colorSlot",
      "icon",
      "homeWorkspaceId",
      "usedWorkspaceIds",
    ])
      expect(h.creates[0]).not.toHaveProperty(k);
  });
});

describe("project/create reports the used spaces that did not link (S9)", () => {
  const WC = "33333333-3333-4333-8333-333333333333";

  it("a failed or proposed link rides `refusals`; the project is the primary id", async () => {
    h.answer = {
      status: "created",
      projectId: "p-1",
      usedWorkspaces: [
        { workspaceId: WA, status: "linked" },
        { workspaceId: WB, status: "failed", error: "No access to that space" },
        { workspaceId: WC, status: "proposed", proposalId: "prop-9" },
      ],
    };
    // 1st read: not yet approved; 2nd: the missed spaces' names (WC unnamed).
    h.rows = [[], [{ id: WB, name: "Brand" }]];
    const result = await approve({
      name: "Lyra",
      usedWorkspaceIds: [WA, WB, WC],
    });
    expect(result.success).toBe(true);
    expect(result.primaryId).toBe("p-1");
    expect(result.refusals).toHaveLength(2);
    expect(result.refusals![0]).toContain('"Brand"');
    expect(result.refusals![0]).toContain("No access to that space");
    expect(result.refusals![1]).toContain(WC);
    expect(result.refusals![1]).toContain("prop-9");
  });

  it("every space linked ⇒ no refusals at all", async () => {
    h.answer = {
      status: "created",
      projectId: "p-1",
      usedWorkspaces: [{ workspaceId: WA, status: "linked" }],
    };
    const result = await approve({ name: "Lyra", usedWorkspaceIds: [WA] });
    expect(result).toEqual({ success: true, primaryId: "p-1" });
  });
});
