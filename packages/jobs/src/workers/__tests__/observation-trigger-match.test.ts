import { describe, it, expect } from "vitest";
import { matchPattern } from "../automation-trigger-matcher.js";

/**
 * Does the RUNTIME matcher actually match an OBSERVATION against the pattern the
 * authoring door now lets you write?
 *
 * This is the third link of a chain whose other two are already proven, and it
 * was the only one with no test at all:
 *
 *   1. the observations door ACCEPTS `dev.commit`      — observations.contract.test.ts
 *   2. the authoring door ACCEPTS the pattern `dev.*`  — types/events/unified.test.ts
 *   3. the matcher MATCHES (1) against (2)             — ← here, previously untested
 *
 * Link 2 was broken until 2026-08-15: `validateEventPattern` rejected every
 * pattern capable of receiving an observation, so the trigger hop fired into a
 * receiver set that could never be populated. It was fixed by declaring
 * `OBSERVATION_NAMESPACES` once in `@synap-core/types` and having both the door
 * and the validator consume it. That fix is worthless if link 3 does not hold,
 * and nothing checked link 3 — no test in this package so much as mentioned
 * `dev.commit`.
 *
 * The matcher is deliberately GENERIC (dotted segments + trailing wildcard), so
 * these cases are not new behaviour — they are the proof that the generic walk
 * covers the namespaces the door registers, and a guard against someone
 * "tightening" it to a first-party SubjectType allowlist later, which would
 * re-sever the chain at a different link.
 */
describe("observation event → automation trigger pattern", () => {
  it("matches an exact observation type", () => {
    expect(matchPattern("dev.commit", "dev.commit")).toBe(true);
    expect(matchPattern("ci.workflow_run", "ci.workflow_run")).toBe(true);
  });

  it("matches a namespace wildcard — the pattern a user is most likely to author", () => {
    expect(matchPattern("dev.commit", "dev.*")).toBe(true);
    expect(matchPattern("dev.gate_run", "dev.*")).toBe(true);
    expect(matchPattern("ci.workflow_run", "ci.*")).toBe(true);
  });

  it("matches a three-segment observation type under a namespace wildcard", () => {
    // Observation types are producer-defined and may carry a third segment;
    // the strict CRUD phase vocabulary does not apply to them.
    expect(matchPattern("ci.workflow_run.success", "ci.*")).toBe(true);
    expect(matchPattern("ci.workflow_run.success", "ci.workflow_run.*")).toBe(
      true
    );
  });

  it("does NOT cross namespaces", () => {
    // The containment that makes a per-namespace pattern meaningful: a CI
    // producer must never fire an automation someone wrote for local dev.
    expect(matchPattern("ci.workflow_run", "dev.*")).toBe(false);
    expect(matchPattern("dev.commit", "ci.*")).toBe(false);
  });

  it("does NOT match a different type inside the same namespace", () => {
    expect(matchPattern("dev.gate_run", "dev.commit")).toBe(false);
  });

  it("keeps observations OUT of first-party patterns, and vice versa", () => {
    // An observation is not a domain event. A pattern written for entity writes
    // must never be woken by a commit being recorded — that separation is the
    // whole reason observations live outside the CRUD taxonomy.
    expect(matchPattern("dev.commit", "entity.*")).toBe(false);
    expect(matchPattern("entity.create.completed", "dev.*")).toBe(false);
  });

  it("never matches an empty or absent pattern", () => {
    expect(matchPattern("dev.commit", undefined)).toBe(false);
    expect(matchPattern("dev.commit", "")).toBe(false);
  });
});
