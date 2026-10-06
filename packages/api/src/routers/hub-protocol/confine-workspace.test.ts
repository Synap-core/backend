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
  // ── ANY bound key is pinned (2026-10-06) ─────────────────────────────────
  // These rows used to assert the OPPOSITE — "bound workspace ignored" for
  // every non-service key — which pinned the defect: pod-admin
  // "workspace-scoped" keys (hub_inbound, user_pat) acted pod-wide.
  it.each(["hub_inbound", "user_pat", null, undefined])(
    "%s key with a binding: refuses another workspace",
    (keyType) => {
      expect(() => resolveConfinedWorkspace(keyType, WS, OTHER)).toThrow(
        /confined to workspace/
      );
    }
  );

  it.each(["hub_inbound", "user_pat"])(
    "%s key with a binding: defaults to and accepts its workspace",
    (keyType) => {
      expect(resolveConfinedWorkspace(keyType, WS, null)).toBe(WS);
      expect(resolveConfinedWorkspace(keyType, WS, undefined)).toBe(WS);
      expect(resolveConfinedWorkspace(keyType, WS, WS)).toBe(WS);
    }
  );

  it("an unbound key of any type stays pod-wide", () => {
    expect(resolveConfinedWorkspace("hub_inbound", null, OTHER)).toBe(OTHER);
    expect(resolveConfinedWorkspace("user_pat", undefined, null)).toBeNull();
    expect(resolveConfinedWorkspace("is_internal", null, OTHER)).toBe(OTHER);
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
