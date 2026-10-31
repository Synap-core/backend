/**
 * The box declaration rule, as the catalog validator and the pod both call it.
 * The pod's own rows (every refusal, the defaults) are in `@synap/api`
 * services/box-runs/box-spec.test.ts; what is pinned here is what the SHARED
 * module owes its two callers.
 */
import { describe, expect, it } from "vitest";
import { BOX_LIMITS, parseBoxDeclaration } from "./index.js";

describe("parseBoxDeclaration (shared)", () => {
  it("is idempotent: parsing the stored shape returns it unchanged (the drift comparator relies on it)", () => {
    const first = parseBoxDeclaration({
      language: "python",
      packages: [{ name: "pandas", version: "2.2.3" }],
      hosts: ["API.example.com"],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(parseBoxDeclaration(first.box)).toEqual(first);
  });

  it("names the field in words, so a catalog author can fix it", () => {
    expect(
      parseBoxDeclaration({
        language: "python",
        packages: [{ name: "pandas", version: ">=2" }],
      })
    ).toEqual({
      ok: false,
      error: "box.packages.0.version: an exact version, e.g. 2.2.3 (no ranges)",
    });
  });

  it("refuses a limit above the per-box budget", () => {
    const r = parseBoxDeclaration({
      language: "node",
      limits: { wallSeconds: BOX_LIMITS.wallSeconds[2] + 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^box\.limits\.wallSeconds/);
  });
});
