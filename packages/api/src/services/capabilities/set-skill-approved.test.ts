/**
 * `setSkillApproved` — the one door behind `skills.setApproved` and
 * `capabilities.setToolEnabled`. The follow-up it owns: turning a verb ON
 * re-queues its pack's connections, so a sync that failed for want of it runs
 * again (live pod 2026-09-25: approved request, stale "not turned on").
 * And it turns on the draft tools the verb `requires`: the page's switch used to
 * flip the skill alone, so writes failed at apply with "installed but not
 * enabled" while the page read "on" (live pod 2026-10-30, hetzner_cloud).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  skill: null as null | {
    id: string;
    workspaceId: string | null;
    approved: boolean;
  },
  packs: [] as Array<{ id: string }>,
  requiredToolIds: [] as string[],
  draftTools: [] as Array<{
    id: string;
    workspaceId: string | null;
    metadata: unknown;
  }>,
  writes: [] as Array<{ table: string; values: unknown }>,
  role: "owner" as string | null,
  podAdmin: true,
}));
const enqueueSyncForCapability = vi.hoisted(() =>
  vi.fn(async () => ({ queued: 1, debounced: 0 }))
);

vi.mock("@synap/database", () => {
  const skills = { __table: "skills", id: "id" };
  const tools = {
    __table: "tools",
    id: "id",
    approved: "approved",
    workspaceId: "workspaceId",
    metadata: "metadata",
  };
  const links = { __table: "links" };
  return {
    db: {
      query: { skills: { findFirst: async () => state.skill } },
      update: (table: { __table: string }) => ({
        set: (v: unknown) => {
          // `update(tools)` awaits `.where()`; `update(skills)` adds `.returning()`.
          state.writes.push({ table: table.__table, values: v });
          const done = Promise.resolve([]);
          return {
            where: () =>
              Object.assign(done, {
                returning: async () => [{ ...state.skill, ...(v as object) }],
              }),
          };
        },
      }),
      // Three reads, told apart by what they select: the pack edges
      // (`{ id }` off links), the `requires` edges (`{ toolId }`), the tools.
      select: (cols: Record<string, unknown>) => ({
        from: (table: { __table: string }) => ({
          where: async () =>
            table.__table === "tools"
              ? state.draftTools
              : "toolId" in cols
                ? state.requiredToolIds.map((toolId) => ({ toolId }))
                : state.packs,
        }),
      }),
    },
    and: (...a: unknown[]) => a,
    eq: (...a: unknown[]) => a,
    inArray: (...a: unknown[]) => a,
    skills,
    tools,
    links,
    // No acting agent: these rows are a human's enable (the agent refusal is
    // pinned in hub-protocol/rest/approve-doors.agent.test.ts).
    getActingAgentUserId: () => undefined,
  };
});
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../utils/workspace-role.js", () => ({
  getWorkspaceRole: async () => state.role,
  requirePodAdmin: async () => {
    if (!state.podAdmin) throw new Error("FORBIDDEN: pod admin only");
  },
}));
vi.mock("../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("./capability-nango-sync.js", () => ({ enqueueSyncForCapability }));

import { setSkillApproved } from "./set-skill-approved.js";

beforeEach(() => {
  state.skill = { id: "s1", workspaceId: "ws", approved: false };
  state.packs = [{ id: "pack-google" }];
  state.requiredToolIds = [];
  state.draftTools = [];
  state.writes = [];
  state.role = "owner";
  state.podAdmin = true;
  enqueueSyncForCapability.mockClear();
});

describe("setSkillApproved", () => {
  it("turning a verb ON re-queues its pack's connections", async () => {
    await setSkillApproved({ userId: "u", skillId: "s1", approved: true });
    expect(state.writes).toEqual([
      { table: "skills", values: expect.objectContaining({ approved: true }) },
    ]);
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

  it("turning a verb ON turns on the draft tool it requires — the flag the apply path reads", async () => {
    // hetzner_cloud: skill switched on from the page, tool left a draft.
    state.skill = { id: "s1", workspaceId: null, approved: true };
    state.requiredToolIds = ["tool-hcloud"];
    state.draftTools = [
      { id: "tool-hcloud", workspaceId: null, metadata: null },
    ];
    await setSkillApproved({ userId: "u", skillId: "s1", approved: true });
    expect(state.writes).toEqual([
      { table: "skills", values: expect.objectContaining({ approved: true }) },
      { table: "tools", values: expect.objectContaining({ approved: true }) },
    ]);
    // A tool turned on is a change of state: its pack's sync runs again.
    expect(enqueueSyncForCapability).toHaveBeenCalledWith("pack-google");
  });

  it("a tool the caller may not approve, or a public form row, stays as it is", async () => {
    state.skill = { id: "s1", workspaceId: "ws", approved: false };
    state.requiredToolIds = ["tool-pod-wide", "tool-form"];
    state.draftTools = [
      // A space owner enabling a space verb that needs a POD-WIDE tool.
      { id: "tool-pod-wide", workspaceId: null, metadata: null },
      { id: "tool-form", workspaceId: "ws", metadata: { form: {} } },
    ];
    state.podAdmin = false;
    await setSkillApproved({ userId: "u", skillId: "s1", approved: true });
    expect(state.writes.map((w) => w.table)).toEqual(["skills"]);
  });

  it("turning a verb OFF leaves its tools alone (another verb may use them)", async () => {
    state.skill = { id: "s1", workspaceId: "ws", approved: true };
    state.requiredToolIds = ["tool-hcloud"];
    state.draftTools = [
      { id: "tool-hcloud", workspaceId: "ws", metadata: null },
    ];
    await setSkillApproved({ userId: "u", skillId: "s1", approved: false });
    expect(state.writes.map((w) => w.table)).toEqual(["skills"]);
  });
});
