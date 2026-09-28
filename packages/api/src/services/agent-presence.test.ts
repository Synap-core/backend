import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Agent presence (V1 G3): the `lastSeenAt` an agent-users row carries is the
 * most recent use of ANY of that agent's keys, and `host` is the instance
 * label of the key it was last seen on. Every row carries the field — `null`
 * = never seen — which is what makes `resolveAgentConnection`
 * (`@synap-core/types/agents`) read the pod as MEASURED, not 'unmeasured'.
 */

const rows: unknown[] = [];
const where = vi.fn(async () => rows);
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: { select: () => ({ from: () => ({ where }) }) },
  };
});

import { loadAgentPresence, withAgentPresence } from "./agent-presence.js";
import { resolveAgentConnection } from "@synap-core/types/agents";

const key = (over: Record<string, unknown>) => ({
  userId: "agent-a",
  lastUsedAt: null,
  instanceId: null,
  isActive: true,
  revokedAt: null,
  ...over,
});

beforeEach(() => {
  rows.length = 0;
  where.mockClear();
});

describe("agent presence", () => {
  it("lastSeenAt = the newest key use; host = that key's instance label; counts live vs pending", async () => {
    rows.push(
      key({
        lastUsedAt: new Date("2026-09-27T10:00:00Z"),
        instanceId: "laptop",
      }),
      key({
        lastUsedAt: new Date("2026-09-28T09:00:00Z"),
        instanceId: "desktop",
      }),
      key({ isActive: false }), // minted, awaiting approval
      key({ isActive: false, revokedAt: new Date() }) // rejected — neither
    );
    const p = (await loadAgentPresence(["agent-a"])).get("agent-a")!;
    expect(p).toEqual({
      lastSeenAt: "2026-09-28T09:00:00.000Z",
      host: "desktop",
      activeKeys: 2,
      pendingKeys: 1,
    });
  });

  it("no ids → no read", async () => {
    expect((await loadAgentPresence([])).size).toBe(0);
    expect(where).not.toHaveBeenCalled();
  });

  it("a failed read throws — 'never seen' and 'could not tell' are different facts", async () => {
    where.mockRejectedValueOnce(new Error("db down"));
    await expect(withAgentPresence([{ id: "agent-a" }])).rejects.toThrow(
      "db down"
    );
  });

  it("every row carries lastSeenAt, so the shared rule reads 'never' (measured), then 'seen'", async () => {
    const never = await withAgentPresence([{ id: "agent-b", name: "Codex" }]);
    expect(never[0]).toHaveProperty("lastSeenAt", null);
    expect(resolveAgentConnection(never)).toEqual({ kind: "never" });

    rows.push(
      key({ userId: "agent-b", lastUsedAt: new Date("2026-09-28T09:00:00Z") })
    );
    const seen = await withAgentPresence([{ id: "agent-b", name: "Codex" }]);
    expect(resolveAgentConnection(seen)).toMatchObject({
      kind: "seen",
      agent: { id: "agent-b" },
    });
  });
});
