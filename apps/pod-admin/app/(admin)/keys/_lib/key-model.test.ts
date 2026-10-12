import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  categorize,
  keyStatus,
  normalizeScopes,
  type UnifiedKey,
} from "./key-model";

const key = (over: Partial<UnifiedKey>): UnifiedKey => ({
  id: "k1",
  keyName: "k",
  keyPrefix: "synap_",
  isActive: true,
  ...over,
});

describe("categorize", () => {
  it.each([
    [{ keyType: "is_internal" }, "system"],
    [{ keyType: "service" }, "service"],
    [{ keyType: "hub_inbound", linkedUserId: "u1" }, "agent"],
    [
      {
        keyType: "hub_inbound",
        linkedUserId: "u1",
        hubId: "integration:cli:abc",
      },
      "cli",
    ],
    [{ keyType: "hub_inbound" }, "system"],
    [{ keyType: "system" }, "system"],
    [{ keyType: "user_pat" }, "operator"],
    [{ keyType: null }, "operator"],
  ] as const)("%o → %s", (over, expected) => {
    expect(categorize(key(over))).toBe(expected);
  });
});

describe("keyStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("revoked wins over any expiry", () => {
    expect(
      keyStatus({ isActive: false, expiresAt: "2030-01-01T00:00:00Z" })
    ).toEqual({ kind: "down", label: "Revoked" });
  });

  it("past expiry is expired", () => {
    expect(
      keyStatus({ isActive: true, expiresAt: "2026-10-11T00:00:00Z" })
    ).toEqual({ kind: "stale", label: "Expired" });
  });

  it("within a week is expiring soon", () => {
    expect(
      keyStatus({ isActive: true, expiresAt: "2026-10-15T00:00:00Z" })
    ).toEqual({ kind: "stale", label: "Expiring soon" });
  });

  it("no expiry or a far one is active", () => {
    expect(keyStatus({ isActive: true })).toEqual({
      kind: "healthy",
      label: "Active",
    });
    expect(
      keyStatus({ isActive: true, expiresAt: "2027-01-01T00:00:00Z" })
    ).toEqual({ kind: "healthy", label: "Active" });
  });
});

describe("normalizeScopes", () => {
  it("accepts an array, a comma list, or nothing", () => {
    expect(normalizeScopes(["a", "b"])).toEqual(["a", "b"]);
    expect(normalizeScopes("a, b,,c ")).toEqual(["a", "b", "c"]);
    expect(normalizeScopes(null)).toEqual([]);
    expect(normalizeScopes("")).toEqual([]);
  });
});
