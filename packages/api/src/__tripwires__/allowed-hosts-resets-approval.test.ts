import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RE_APPROVAL_FIELDS,
  allowedHostsChanged,
} from "../services/capabilities/skill-exec-fields.js";

/**
 * Widening a skill's egress allowlist must demote its approval.
 *
 * `metadata.allowedHosts` is what the sandbox enforces — `run-skill-in-sandbox`
 * reads it and `host.fetch` refuses every host not on it. So it decides where
 * an APPROVED skill may reach, which makes it execution-defining.
 *
 * It could not simply join `RE_APPROVAL_FIELDS`: `metadata` is a free-form bag
 * that the update door peels off `updateData` and shallow-merges separately, so
 * the field comparison cannot see it. The hole that left was asymmetric and
 * backwards — re-pointing a declarative skill's `providerSpec.baseUrl` at
 * evil.com demoted it, while ADDING evil.com to its allowlist did not. The
 * narrower-looking edit was the ungated one.
 */
describe("allowedHosts is treated as execution-defining", () => {
  it("the guard is VALUE-based, not presence-based", () => {
    // A form that re-sends an unchanged allowlist on every save must not demote
    // the skill — a presence test caused exactly that regression on the
    // MCP-server door, silently pulling approved tools out of LLM requests.
    expect(
      allowedHostsChanged(
        { allowedHosts: ["api.vendor.com"] },
        { allowedHosts: ["api.vendor.com"] }
      )
    ).toBe(false);
    expect(
      allowedHostsChanged(
        { allowedHosts: ["a.com"] },
        { allowedHosts: ["a.com"] }
      )
    ).toBe(false);
  });

  it("widening, narrowing, or first-setting the allowlist all count as a change", () => {
    expect(
      allowedHostsChanged(
        { allowedHosts: ["a.com", "evil.com"] },
        { allowedHosts: ["a.com"] }
      )
    ).toBe(true);
    expect(
      allowedHostsChanged(
        { allowedHosts: ["a.com"] },
        { allowedHosts: ["a.com", "b.com"] }
      )
    ).toBe(true);
    expect(allowedHostsChanged({ allowedHosts: ["evil.com"] }, {})).toBe(true);
    expect(allowedHostsChanged({ allowedHosts: ["evil.com"] }, null)).toBe(
      true
    );
  });

  it("a metadata patch that does not mention allowedHosts is not a change", () => {
    // `marketSource` advances on every template reconcile; demoting an approved
    // skill for that would break the standalone-config reconcile loop.
    expect(
      allowedHostsChanged(
        { marketSource: { slug: "x" } },
        { allowedHosts: ["a.com"] }
      )
    ).toBe(false);
    expect(allowedHostsChanged(undefined, { allowedHosts: ["a.com"] })).toBe(
      false
    );
  });

  it("the update door actually consults the guard", () => {
    // Source-scanned because asserting it behaviourally needs a live DB. The
    // two doors that rewrite a skill row have drifted apart once already, which
    // is why `skill-exec-fields.ts` exists at all.
    const src = readFileSync(join(__dirname, "../routers/skills.ts"), "utf8");
    expect(
      src.length,
      "source unreadable — assertion would be vacuous"
    ).toBeGreaterThan(1000);
    // Strip comments in ONE pass; a sequential strip has eaten real code here
    // before, at an apostrophe inside a string.
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).toContain("allowedHostsChanged(");
    // It must feed the same `execChanged` decision that writes `approved: false`.
    expect(code).toMatch(/execChanged[\s\S]{0,800}allowedHostsChanged\(/);
    expect(code).toMatch(/execChanged \? \{ approved: false \}/);
  });

  it("RE_APPROVAL_FIELDS still covers the fields it always did", () => {
    // Guards against someone "simplifying" the list while adding the new check.
    for (const f of [
      "code",
      "providerSpec",
      "parameters",
      "executionMode",
      "timeoutSeconds",
      "kind",
    ]) {
      expect(RE_APPROVAL_FIELDS as readonly string[]).toContain(f);
    }
  });
});
