/**
 * THE regression pin for the 2026-08-18 finding: `New Contact Enrichment`'s
 * command node killed its run with "Cannot convert undefined or null to
 * object". The shipped `relay-new-contact-enrichment` template authors that
 * node with `input` / `prompt` / `commandId` and NO `inputMapping`, so
 * `resolveInputMapping(data.inputMapping, ctx)` reached
 * `Object.entries(undefined)`.
 *
 * The optionality was already known — three of the four call sites guarded it
 * with `?? {}` or a ternary. Only the extracted command-step path did not, and
 * the non-optional signature (`mapping: Record<string, string>`) meant tsc
 * could never flag it. Runtime data disagreed with the type; only postgres and
 * the executor found out.
 *
 * Pinned here so the guard cannot be removed by "tidying" the signature back.
 */
import { describe, it, expect } from "vitest";
import { resolveInputMapping } from "../template-resolve.js";
// StepContext lives in automation-executor-types (template-resolve only
// re-imports it) — and the fixture below is a REAL StepContext, not a cast:
// a cast here would hide the very type/runtime disagreement this file pins.
import type { StepContext } from "../automation-executor-types.js";

const ctx: StepContext = {
  trigger: {
    payload: { subjectId: "abc-123", data: { profileSlug: "person" } },
  },
  steps: {},
  automation: { id: "auto-1", state: {} },
};

describe("resolveInputMapping — absent mapping", () => {
  it("returns {} for undefined instead of throwing (the live failure)", () => {
    expect(() => resolveInputMapping(undefined, ctx)).not.toThrow();
    expect(resolveInputMapping(undefined, ctx)).toEqual({});
  });

  it("returns {} for null", () => {
    expect(resolveInputMapping(null, ctx)).toEqual({});
  });

  it("still resolves a real mapping — the guard must not swallow work", () => {
    const out = resolveInputMapping(
      { subject: "{{trigger.payload.subjectId}}" },
      ctx
    );
    expect(out).toEqual({ subject: "abc-123" });
  });

  it("an empty mapping is indistinguishable from an absent one", () => {
    expect(resolveInputMapping({}, ctx)).toEqual(
      resolveInputMapping(undefined, ctx)
    );
  });
});

describe("the assertion can fail (anti-vacuity control)", () => {
  it("Object.entries(undefined) really does throw the observed message", () => {
    expect(() => Object.entries(undefined as never)).toThrow(
      /Cannot convert undefined or null to object/
    );
  });
});
