/**
 * The sibling-repo override is honoured, and one that points nowhere says so:
 * a mistyped SYNAP_APP_DIR must not read like "no checkout here" while every
 * cross-repo guard quietly skips. Named `*.tripwire.test.ts` so
 * `pnpm tripwires` (CI) runs it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { siblingCheckout } from "./sibling-checkout.mjs";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("siblingCheckout — the override variable", () => {
  it("returns the override when it exists, without a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "sibling-"));
    try {
      vi.stubEnv("SYNAP_APP_DIR", dir);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(siblingCheckout("synap-app")).toBe(dir);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns, naming the variable and the path, when the override is missing", () => {
    const missing = join(tmpdir(), "no-such-synap-control-plane");
    vi.stubEnv("SYNAP_CONTROL_PLANE_DIR", missing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(siblingCheckout("synap-control-plane-api")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("SYNAP_CONTROL_PLANE_DIR");
    expect(warn.mock.calls[0]?.[0]).toContain(missing);
  });
});
