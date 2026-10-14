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
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  creates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // select → from → where resolves no row (not yet approved); update chains.
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "from", "update", "set"]) chain[k] = () => chain;
  chain.where = async () => [];
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
        return { status: "created", projectId: "p-1" };
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
  await executor.execute({
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
