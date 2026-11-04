/**
 * `setSkillApproved` — the one door behind `skills.setApproved` and
 * `capabilities.setToolEnabled`. The follow-up it owns: turning a verb ON
 * re-queues its pack's connections, so a sync that failed for want of it runs
 * again (live pod 2026-09-25: approved request, stale "not turned on").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PresenceProof } from "@synap-core/types/presence";

const state = vi.hoisted(() => ({
  skill: null as null | {
    id: string;
    workspaceId: string | null;
    approved: boolean;
  },
  packs: [] as Array<{ id: string }>,
  writes: [] as unknown[],
  role: "owner" as string | null,
}));
const enqueueSyncForCapability = vi.hoisted(() =>
  vi.fn(async () => ({ queued: 1, debounced: 0 }))
);

vi.mock("@synap/database", () => ({
  db: {
    query: { skills: { findFirst: async () => state.skill } },
    update: () => ({
      set: (v: unknown) => ({
        where: () => ({
          returning: async () => {
            state.writes.push(v);
            return [{ ...state.skill, ...(v as object) }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({ where: async () => state.packs }),
    }),
  },
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  skills: { id: "id" },
  links: {},
  // No acting agent: these rows are a human's enable (the agent refusal is
  // pinned in hub-protocol/rest/approve-doors.agent.test.ts).
  getActingAgentUserId: () => undefined,
}));
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../utils/workspace-role.js", () => ({
  getWorkspaceRole: async () => state.role,
  requirePodAdmin: async () => undefined,
}));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("./capability-nango-sync.js", () => ({ enqueueSyncForCapability }));
// The presence gate (W3): its own suite is presence.pglite.test.ts; here only
// WHEN this door asks it, and that a refusal writes nothing.
const assertPresenceForRequest = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => undefined)
);
vi.mock("../presence/gate.js", () => ({ assertPresenceForRequest }));

import { setSkillApproved } from "./set-skill-approved.js";

beforeEach(() => {
  state.skill = { id: "s1", workspaceId: "ws", approved: false };
  state.packs = [{ id: "pack-google" }];
  state.writes = [];
  state.role = "owner";
  enqueueSyncForCapability.mockClear();
  assertPresenceForRequest.mockReset();
  assertPresenceForRequest.mockResolvedValue(undefined);
});

describe("setSkillApproved", () => {
  it("turning a verb ON re-queues its pack's connections", async () => {
    await setSkillApproved({ userId: "u", skillId: "s1", approved: true });
    expect(state.writes).toEqual([expect.objectContaining({ approved: true })]);
    expect(enqueueSyncForCapability).toHaveBeenCalledWith("pack-google");
  });

  it("an already-on verb, or turning one OFF, queues nothing", async () => {
    state.skill = { id: "s1", workspaceId: "ws", approved: true };
    await setSkillApproved({ userId: "u", skillId: "s1", approved: true });
    await setSkillApproved({ userId: "u", skillId: "s1", approved: false });
    expect(enqueueSyncForCapability).not.toHaveBeenCalled();
  });

  it("a queue fault never fails the enable that already landed", async () => {
    enqueueSyncForCapability.mockRejectedValueOnce(new Error("boss down"));
    await expect(
      setSkillApproved({ userId: "u", skillId: "s1", approved: true })
    ).resolves.toBeTruthy();
  });

  it("a non-owner is refused and nothing is written", async () => {
    state.role = "member";
    await expect(
      setSkillApproved({ userId: "u", skillId: "s1", approved: true })
    ).rejects.toThrow(/workspace owners/);
    expect(state.writes).toEqual([]);
    expect(enqueueSyncForCapability).not.toHaveBeenCalled();
  });

  describe("proof of presence (W3: turning a skill or tool ON is sensitive)", () => {
    const proof: PresenceProof = {
      kind: "device_key",
      challengeId: "00000000-0000-4000-8000-0000000000c1",
      keyId: "00000000-0000-4000-8000-0000000000d1",
      signature: "c2ln",
    };

    it("turning ON asks the gate for THIS skill with the proof sent", async () => {
      await setSkillApproved({
        userId: "u",
        skillId: "s1",
        approved: true,
        presence: proof,
        door: "skills.setApproved",
      });
      expect(assertPresenceForRequest).toHaveBeenCalledWith({
        userId: "u",
        kind: "skill",
        id: "s1",
        proof,
        door: "skills.setApproved",
      });
    });

    it("a refused proof turns nothing on and queues nothing", async () => {
      assertPresenceForRequest.mockRejectedValueOnce(
        new Error("PRESENCE_REQUIRED")
      );
      await expect(
        setSkillApproved({ userId: "u", skillId: "s1", approved: true })
      ).rejects.toThrow(/PRESENCE_REQUIRED/);
      expect(state.writes).toEqual([]);
      expect(enqueueSyncForCapability).not.toHaveBeenCalled();
    });

    it("turning OFF, or the executor of an approval already proved, does not ask", async () => {
      await setSkillApproved({ userId: "u", skillId: "s1", approved: false });
      await setSkillApproved({
        userId: "u",
        skillId: "s1",
        approved: true,
        presenceChecked: "applyProposalApproval",
      });
      expect(assertPresenceForRequest).not.toHaveBeenCalled();
      expect(state.writes).toHaveLength(2);
    });
  });
});
