/**
 * REGRESSION — the goal-template grammar fork that produced 49 broken sessions.
 *
 * Two template grammars exist and neither resolver speaks both:
 *   • `resolveTemplate` (this package) understands ONLY `{{mustache}}`.
 *   • `resolveGoal` (the api spine) understands ONLY `@{arg:name:type}`.
 *
 * The automation path passed its own resolver's output as `goalOverride`, which
 * REPLACES the spine's resolveGoal entirely. A goalTemplate authored as
 * `@{arg:company:entity}` contains zero `{{ }}`, so resolveTemplate returned it
 * BYTE-FOR-BYTE and that raw placeholder was stored as the session goal — 49
 * times, once per company in one automation fan-out. It never registered as a
 * "miss", so no diagnostic fired.
 *
 * The rule these tests pin: when our resolver did not (and cannot) substitute,
 * it must return `undefined` — "wrong resolver for this grammar" — so the spine
 * falls back to the resolver that speaks it. `{{ }}` behavior is unchanged.
 */
import { describe, it, expect } from "vitest";

/** Mirrors the goalResolver rule in steps/playbook-run.ts. */
function goalResolverRule(
  goalTemplate: string,
  resolve: (t: string) => string
): string | undefined {
  const resolved = resolve(goalTemplate);
  if (resolved === goalTemplate && goalTemplate.includes("@{arg:")) {
    return undefined;
  }
  return resolved || goalTemplate;
}

/** Stand-in for resolveTemplate: substitutes {{...}} only, misses render "". */
const mustacheOnly = (vals: Record<string, string>) => (t: string) =>
  t.replace(/\{\{(.+?)\}\}/g, (_, k: string) => vals[k.trim()] ?? "");

describe("playbook_run goalResolver — grammar fork", () => {
  it("DEFERS on an @{arg:} template instead of passing the raw placeholder on", () => {
    const tpl =
      "Advance @{arg:company:entity} through the Stellar grant process";
    const out = goalResolverRule(tpl, mustacheOnly({}));
    // The exact production bug: this must NOT come back as the literal template.
    expect(out).toBeUndefined();
    // Whatever the caller receives, it must never carry the raw placeholder.
    expect(out ?? "").not.toContain("@{arg:");
  });

  it("still resolves {{mustache}} templates exactly as before", () => {
    const out = goalResolverRule(
      "Qualify {{trigger.company}} now",
      mustacheOnly({ "trigger.company": "Acme" })
    );
    expect(out).toBe("Qualify Acme now");
  });

  it("keeps the documented empty-string miss behavior for {{mustache}}", () => {
    // A {{...}} miss still renders "" — flows depend on it. Because the text
    // CHANGED, this is a real resolution and must not defer.
    const out = goalResolverRule("Steer: {{trigger.prompt}}", mustacheOnly({}));
    expect(out).toBe("Steer: ");
  });

  it("does not defer for a plain goal with no references at all", () => {
    const out = goalResolverRule("Run the weekly audit", mustacheOnly({}));
    expect(out).toBe("Run the weekly audit");
  });

  it("defers for every arg type spelling, not just :entity", () => {
    for (const tpl of [
      "Do @{arg:company:entity}",
      "Do @{arg:platform:text}",
      "Do @{arg:x}",
    ]) {
      expect(goalResolverRule(tpl, mustacheOnly({}))).toBeUndefined();
    }
  });
});
