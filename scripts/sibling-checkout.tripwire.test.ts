/**
 * The sibling-repo override is honoured, and one that points nowhere says so:
 * a mistyped SYNAP_APP_DIR must not read like "no checkout here" while every
 * cross-repo guard quietly skips. Named `*.tripwire.test.ts` so
 * `pnpm tripwires` (CI) runs it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_ROOT,
  siblingCheckout,
  warnIfOffPin,
} from "./sibling-checkout.mjs";

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

// A local sibling at another commit than its pin (sibling-pins.json) WARNS,
// once, and never fails: CI reads the pin, so a guard may disagree with CI.
describe("warnIfOffPin — a local sibling away from its pin", () => {
  it("warns once for a checkout off its pin, says nothing at the pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "pins-"));
    try {
      const head = execFileSync(
        "git",
        ["-C", BACKEND_ROOT, "rev-parse", "HEAD"],
        {
          encoding: "utf8",
        }
      ).trim();
      const pins = join(dir, "sibling-pins.json");
      writeFileSync(
        pins,
        JSON.stringify({
          repos: [
            { dir: "synap-app", repo: "Synap-core/app-bases", ref: head },
            {
              dir: "synap-control-plane-api",
              repo: "Synap-core/control-plane-api",
              ref: "0".repeat(40),
            },
          ],
        })
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      warnIfOffPin("synap-app", BACKEND_ROOT, pins);
      expect(warn).not.toHaveBeenCalled();
      warnIfOffPin("synap-control-plane-api", BACKEND_ROOT, pins);
      warnIfOffPin("synap-control-plane-api", BACKEND_ROOT, pins);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]?.[0]).toContain("not its pin 0000000000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
