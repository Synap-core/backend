/**
 * `setSkillApproved` — the one door behind `skills.setApproved` and
 * `capabilities.setToolEnabled`. The follow-up it owns: turning a verb ON
 * re-queues its pack's connections, so a sync that failed for want of it runs
 * again (live pod 2026-09-25: approved request, stale "not turned on").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { setSkillApproved } from "./set-skill-approved.js";

beforeEach(() => {
  state.skill = { id: "s1", workspaceId: "ws", approved: false };
  state.packs = [{ id: "pack-google" }];
  state.writes = [];
  state.role = "owner";
  enqueueSyncForCapability.mockClear();
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
});
