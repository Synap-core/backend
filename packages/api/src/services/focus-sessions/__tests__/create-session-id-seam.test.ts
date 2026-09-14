/**
 * ONE id per created session — the governance receipt and the row agree.
 *
 * `createFocusSession` used to leave the id to the column default, so the
 * auto-approve receipt (`permission-check.ts`, `targetId: data?.id ??
 * randomUUID()`) minted its OWN random id that no row ever had. Live on
 * 2026-09-14: a human session create filed receipt 91191f04 while the session
 * it described was 48184fd0. Now the id is minted once, sent as `data.id`, and
 * inserted as the row id.
 *
 * Driven through the real `createFocusSession`, with the permission door and the
 * db mocked at their module seams. What it cannot see: that `permission-check`
 * really stamps `data.id` as the receipt targetId and the PROPOSED path's
 * prospective id (`permission-check.ts` `data.documentId || data.entityId ||
 * data.id`) — that consumption is not exercised here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  permArgs: [] as Array<{ data: Record<string, unknown> }>,
  inserted: [] as Array<Record<string, unknown>>,
  permResult: {} as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        h.inserted.push(v);
        return {
          returning: vi.fn(async () => [
            {
              ...v,
              channelId: "channel-1",
              expectedOutputs: [],
              status: "active",
            },
          ]),
        };
      }),
    })),
  };
  return {
    ...actual,
    db: {
      transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      query: {
        focusSessions: { findFirst: vi.fn(async () => null) },
        playbooks: { findFirst: vi.fn(async () => null) },
      },
    },
    resolveSessionProjectPlacement: vi.fn(async () => ({ projectId: null })),
    recordSessionSpawn: vi.fn(),
  };
});
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(
    async (args: { data: Record<string, unknown> }) => {
      h.permArgs.push(args);
      return h.permResult;
    }
  ),
  proposedMessageFor: vi.fn(() => "Focus session creation proposed for review"),
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../block-guidelines.js", () => ({
  guidanceForBlockedSlots: vi.fn(async () => undefined),
  newlyBlockedSlots: vi.fn(() => []),
}));
vi.mock("../assert-output-ref-visible.js", () => ({
  findUnreachableOutputRefs: vi.fn(async () => []),
  unreachableOutputRefError: vi.fn(() => "unreachable"),
}));
vi.mock("../session-blocked-by.js", () => ({
  addCreateTimeBlockers: vi.fn(async () => []),
}));
vi.mock("../update-session.js", () => ({
  sanitizeDeclaredOutputs: (x: unknown) => x,
}));

import { createFocusSession } from "../create-session.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("createFocusSession — one id for the receipt and the row", () => {
  beforeEach(() => {
    h.permArgs.length = 0;
    h.inserted.length = 0;
    h.permResult = {};
  });

  it("auto-approved: the id sent to the permission door IS the inserted row id", async () => {
    const result = await createFocusSession({
      userId: "user-1",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Ship the thing",
    });

    const sentId = h.permArgs[0]?.data.id;
    expect(sentId).toMatch(UUID);
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0].id).toBe(sentId);
    expect(result.status).toBe("created");
    if (result.status === "created") expect(result.session.id).toBe(sentId);
  });

  it("proposed: the proposal still carries the minted id, and nothing is inserted", async () => {
    h.permResult = {
      proposalId: "proposal-1",
      proposalType: "focus_session.create",
    };
    const result = await createFocusSession({
      userId: "user-1",
      agentUserId: "agent-1",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Ship the thing",
    });

    expect(result.status).toBe("proposed");
    expect(h.permArgs[0]?.data.id).toMatch(UUID);
    expect(h.inserted).toHaveLength(0);
  });

  it("each create mints its own id", async () => {
    await createFocusSession({ userId: "user-1", goal: "A" });
    await createFocusSession({ userId: "user-1", goal: "B" });
    expect(h.permArgs[0].data.id).not.toBe(h.permArgs[1].data.id);
    expect(h.inserted[0].id).not.toBe(h.inserted[1].id);
  });
});
