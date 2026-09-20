/**
 * SECURITY tripwire: a declared READ never bypasses ORIGIN TRUST.
 *
 * THE REGRESSION THIS GUARDS, which we shipped and caught in review on the same
 * day (2026-09-20):
 *
 * The read-only short-circuit (`if (input.readOnly) return { decision: "run" }`)
 * used to sit ABOVE the origin-trust rung, and that was safe only while
 * `readOnly` meant a BUILTIN read (a local hub op) or a GET/HEAD provider call.
 * Introducing the AUTHORED `metadata.readOnly` declaration widened it to any
 * verb whose definition claims it — including `exa_search`, a `kind:"code"`
 * verb performing an outbound HTTP POST with a CALLER-SUPPLIED body.
 *
 * The opened attack: content arriving on an untrusted bridge / EXTERNAL channel
 * prompt-injects the agent into `exa_search({ query: "<pod content>" })`. Before
 * the widening that force-proposed; after it, with the short-circuit first, it
 * would auto-run and ship pod text to a third party with no human in the loop.
 *
 * `readOnly` means "does not mutate POD state". It has never meant "no external
 * effect" — and this very wave made that split explicit by returning `false`
 * from `capabilityVerbHasExternalEffect` for those same verbs. An EXFILTRATION
 * channel is a read.
 *
 * WHAT THIS DOES NOT COVER, measured: this is a SOURCE-ORDER assertion. It
 * proves the origin-trust resolution precedes the read-only return and that the
 * return is guarded by an untrusted check; it does NOT execute the gate against
 * a real untrusted channel (that needs a DB and lives in the gate's behavioural
 * suite). It would not catch a change that keeps the order but breaks
 * `resolveOriginTrust` itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("./index.ts", import.meta.url)),
  "utf8"
);

/** Strip comments so prose can never satisfy — or trip — these scans. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("SECURITY: a declared read does not bypass origin trust", () => {
  it("NON-VACUITY: the scan can see the three landmarks it reasons about", () => {
    // If any of these stops matching, every ordering assertion below becomes
    // vacuous — a guard that passes while looking at nothing.
    expect(CODE).toContain("resolveOriginTrust");
    expect(CODE).toContain("input.readOnly");
    expect(CODE).toContain("buildProposeDecision");
  });

  it("origin trust is RESOLVED BEFORE the read-only short-circuit", () => {
    const resolvedAt = CODE.indexOf("resolveOriginTrust");
    const readOnlyAt = CODE.indexOf("input.readOnly");
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(readOnlyAt).toBeGreaterThan(-1);
    expect(
      resolvedAt,
      "the read-only short-circuit returns before origin trust is resolved — " +
        "an untrusted channel can auto-run a declared read, which is an " +
        "exfiltration path for any read that carries a caller-supplied body"
    ).toBeLessThan(readOnlyAt);
  });

  it("the read-only branch force-proposes on an untrusted origin", () => {
    // Take the read-only block: from `input.readOnly` to its closing `run`.
    const start = CODE.indexOf("input.readOnly");
    const block = CODE.slice(start, start + 400);
    expect(
      block,
      "the read-only branch must consult originTrust before returning `run`"
    ).toContain("untrusted");
    expect(block, "an untrusted origin must PROPOSE, not run").toContain(
      "buildProposeDecision"
    );
    // And the propose must come FIRST — a `return { decision: "run" }` ahead of
    // the untrusted check would make the check dead code.
    expect(block.indexOf("buildProposeDecision")).toBeLessThan(
      block.indexOf('decision: "run"')
    );
  });
});
