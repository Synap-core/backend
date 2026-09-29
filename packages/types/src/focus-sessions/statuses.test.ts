import { describe, expect, it } from "vitest";
import {
  OPEN_SESSION_STATUSES,
  SESSION_STATUSES,
  SUSPENDED_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  isSuspendedSessionStatus,
} from "./statuses.js";

describe("SUSPENDED_SESSION_STATUSES — the one reading of `stale`", () => {
  it("is exactly paused + stale, every member a real status", () => {
    expect([...SUSPENDED_SESSION_STATUSES].sort()).toEqual(["paused", "stale"]);
    for (const s of SUSPENDED_SESSION_STATUSES)
      expect(SESSION_STATUSES).toContain(s);
  });

  it("never overlaps the terminal set (stale is resumable, not done)", () => {
    for (const s of SUSPENDED_SESSION_STATUSES) {
      expect(TERMINAL_SESSION_STATUSES as readonly string[]).not.toContain(s);
    }
  });

  it("reads stale as suspended, and a live or settled status as not", () => {
    expect(isSuspendedSessionStatus("stale")).toBe(true);
    expect(isSuspendedSessionStatus("active")).toBe(false);
    expect(isSuspendedSessionStatus("closed")).toBe(false);
    expect(isSuspendedSessionStatus(null)).toBe(false);
    // `paused` is ALSO in the pod's OPEN set — that set answers a different
    // question ("not finished") and is deliberately left alone.
    expect(OPEN_SESSION_STATUSES as readonly string[]).toContain("paused");
  });
});
