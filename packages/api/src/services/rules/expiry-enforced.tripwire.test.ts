import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * An expiry nobody filters on is decorative, and worse than absent: the owner
 * believes a rule lapsed while it keeps steering the agent. `ruleNotExpiredWhere`
 * shipped with ZERO production consumers once already — this pins the doors.
 *
 * The distinction below is the design, not an accident:
 *
 *   ENFORCE — the agent-facing reads. `skills.getSkills` backs
 *   `/agent-skills/executable`, which is what the IS `dynamic-skill-loader`
 *   calls before injecting standing rules into the model's prompt.
 *   `GET /agent-skills` is the instruction catalog. A lapsed rule must not
 *   reach an agent through either.
 *
 *   DO NOT ENFORCE — `GET /api/hub/rules`, the management listing. Expiry stops
 *   a rule from ACTING; it must not hide it. Filtering there would turn an
 *   expired rule into a ghost its owner can neither see, renew, nor delete.
 */
const API_SRC = join(__dirname, "../..");

const ENFORCING = [
  "routers/skills.ts",
  "routers/hub-protocol/rest/agent-skills.ts",
];
const MUST_NOT_ENFORCE = ["routers/hub-protocol/rest/rules.ts"];

function read(rel: string): string {
  const path = join(API_SRC, rel);
  if (!existsSync(path)) throw new Error(`guarded file is missing: ${rel}`);
  return readFileSync(path, "utf8");
}

describe("rule expiry is enforced at the agent-facing doors", () => {
  it("finds every file it claims to guard (never vacuously green)", () => {
    for (const rel of [...ENFORCING, ...MUST_NOT_ENFORCE]) {
      expect(() => read(rel), rel).not.toThrow();
    }
  });

  // Assert the CALL, not the mention: the import line alone satisfies a bare
  // `toContain`, so the first version of this test passed with the door
  // un-wired. Caught by mutation-checking it.
  it.each(ENFORCING)("%s applies the expiry predicate", (rel) => {
    expect(read(rel)).toMatch(/ruleNotExpiredWhere\s*\(/);
  });

  it.each(MUST_NOT_ENFORCE)(
    "%s does NOT — an expired rule stays visible to its owner",
    (rel) => {
      expect(read(rel)).not.toMatch(/ruleNotExpiredWhere\s*\(/);
    }
  );
});
