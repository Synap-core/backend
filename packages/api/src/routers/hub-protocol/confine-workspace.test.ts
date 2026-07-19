/**
 * Unit tests for service-key workspace confinement (Item 3).
 *
 * Pure truth-table coverage — no DB, no I/O.
 */

import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { resolveConfinedWorkspace } from "./confine-workspace.js";

const WS = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("resolveConfinedWorkspace", () => {
  // ── Legacy passthrough — the ONLY behavior for non-service keys ──────────
  it("non-service key: returns requested UNCHANGED (bound workspace ignored)", () => {
    expect(resolveConfinedWorkspace("hub_inbound", WS, OTHER)).toBe(OTHER);
    expect(resolveConfinedWorkspace("hub_inbound", WS, null)).toBeNull();
    expect(
      resolveConfinedWorkspace("hub_inbound", WS, undefined)
    ).toBeUndefined();
    expect(resolveConfinedWorkspace("user_pat", WS, OTHER)).toBe(OTHER);
    expect(resolveConfinedWorkspace("is_internal", WS, OTHER)).toBe(OTHER);
  });

  it("null/undefined keyType: returns requested UNCHANGED", () => {
    expect(resolveConfinedWorkspace(null, WS, OTHER)).toBe(OTHER);
    expect(resolveConfinedWorkspace(undefined, WS, OTHER)).toBe(OTHER);
  });

  // ── Service key WITHOUT binding — passthrough (never confines) ───────────
  it("service key with null binding: returns requested UNCHANGED", () => {
    expect(resolveConfinedWorkspace("service", null, OTHER)).toBe(OTHER);
    expect(resolveConfinedWorkspace("service", undefined, OTHER)).toBe(OTHER);
    expect(resolveConfinedWorkspace("service", null, null)).toBeNull();
  });

  // ── Service key WITH binding — positive pin ─────────────────────────────
  it("service + bound + no requested: defaults to the bound workspace", () => {
    expect(resolveConfinedWorkspace("service", WS, null)).toBe(WS);
    expect(resolveConfinedWorkspace("service", WS, undefined)).toBe(WS);
  });

  it("service + bound + matching request: returns the bound workspace", () => {
    expect(resolveConfinedWorkspace("service", WS, WS)).toBe(WS);
  });

  it("service + bound + different request: THROWS 403 FORBIDDEN", () => {
    expect(() => resolveConfinedWorkspace("service", WS, OTHER)).toThrow(
      TRPCError
    );
    try {
      resolveConfinedWorkspace("service", WS, OTHER);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("FORBIDDEN");
      expect((err as TRPCError).message).toContain(WS);
    }
  });
});
