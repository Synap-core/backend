import { describe, expect, it } from "vitest";
import {
  OPEN_SESSION_STATUSES,
  SESSION_STATUSES,
  SUSPENDED_SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  isSuspendedSessionStatus,
  closedRunRefusal,
  isCancelledRunReopen,
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

describe("closedRunRefusal — a closed run stays closed (R8)", () => {
  it("refuses every terminal → open move", () => {
    for (const from of ["closed", "cancelled", "failed"]) {
      for (const to of ["active", "paused", "forming", "scheduled", "stale"]) {
        expect(closedRunRefusal(from, to)).toMatch(/stays closed/);
      }
    }
  });
  it("allows an open run to move anywhere, a no-op, an absent status, and terminal → terminal", () => {
    expect(closedRunRefusal("active", "paused")).toBeNull();
    expect(closedRunRefusal("paused", "closed")).toBeNull();
    expect(closedRunRefusal("closed", "closed")).toBeNull();
    expect(closedRunRefusal("closed", undefined)).toBeNull();
    expect(closedRunRefusal("closed", "cancelled")).toBeNull();
  });
});

describe("closedRunRefusal — the person's reopen of a cancelled run (decision 3da00cda)", () => {
  it("lets a PERSON move a cancelled run back to active", () => {
    expect(closedRunRefusal("cancelled", "active", "person")).toBeNull();
    expect(isCancelledRunReopen("cancelled", "active")).toBe(true);
  });
  it("refuses an AGENT, and a door that cannot tell, with the person-only reason", () => {
    for (const actor of ["agent", undefined, null] as const) {
      expect(closedRunRefusal("cancelled", "active", actor)).toMatch(
        /only a person can reopen a cancelled run/
      );
    }
  });
  it("reopens to active only", () => {
    expect(closedRunRefusal("cancelled", "paused", "person")).toMatch(
      /reopens as active only/
    );
    expect(isCancelledRunReopen("cancelled", "paused")).toBe(false);
  });
  it("keeps a closed or failed run closed, even for a person", () => {
    for (const from of ["closed", "failed"]) {
      expect(closedRunRefusal(from, "active", "person")).toMatch(
        /stays closed/
      );
      expect(isCancelledRunReopen(from, "active")).toBe(false);
    }
  });
});
