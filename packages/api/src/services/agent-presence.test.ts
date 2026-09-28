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
import {
  resolveAgentConnection,
  resolveAgentMark,
} from "@synap-core/types/agents";

const key = (over: Record<string, unknown>) => ({
  userId: "agent-a",
  lastUsedAt: null,
  instanceId: null,
  isActive: true,
  revokedAt: null,
  expiresAt: null,
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
      revokedKeys: 1,
    });
  });

  it("an EXPIRED key is neither live nor pending; a future expiry still counts", async () => {
    const now = new Date("2026-09-28T12:00:00Z");
    rows.push(
      key({ expiresAt: new Date("2026-09-28T11:59:59Z") }), // expired, active
      key({ isActive: false, expiresAt: new Date("2026-09-01T00:00:00Z") }), // expired, pending
      key({ expiresAt: new Date("2026-12-01T00:00:00Z") }) // live
    );
    const p = (await loadAgentPresence(["agent-a"], now)).get("agent-a")!;
    expect(p.activeKeys).toBe(1);
    expect(p.pendingKeys).toBe(0);
    // Both expired keys existed and can no longer call: evidence of a cut.
    expect(p.revokedKeys).toBe(2);
  });

  it("an agent that never held a key reports revokedKeys 0 — never 'Disconnected'", async () => {
    const [row] = await withAgentPresence([{ id: "agent-new" }]);
    expect(row.revokedKeys).toBe(0);
    expect(resolveAgentMark({ ...row, name: "Codex" }).kind).toBe("noKey");
  });

  it("a revoked key reaches the shared mark as Disconnected", async () => {
    rows.push(
      key({
        isActive: false,
        revokedAt: new Date("2026-09-28T08:00:00Z"),
        lastUsedAt: new Date("2026-09-28T07:00:00Z"),
      })
    );
    const [row] = await withAgentPresence([{ id: "agent-a" }]);
    expect(resolveAgentMark({ ...row, name: "Codex" }).kind).toBe(
      "disconnected"
    );
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
