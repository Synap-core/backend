import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * AGENT-OWNER-FLOOR-ONE-DOOR TRIPWIRE
 *
 * `agents.userId` is the ACTOR (the agent-user), NOT the human owner — the two
 * meanings were conflated, so flooring the catalog on `eq(agents.userId, <caller
 * id>)` never matched a local/CLI adjunct (actor id ≠ human id) and a human could
 * not see their OWN adjunct. The owner signal is the actor's `users.createdByUserId`.
 *
 * This gate keeps every catalog reader flooring through the ONE door
 * `ownAdjunctFilter` (agent-identity-service.ts) and forbids the human-misread
 * `eq(agents.userId, userId)` / `eq(agents.userId, ctx.userId)` from returning.
 */

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const READERS = ["routers/agents.ts", "services/object-graph/graph-service.ts"];

// Matches eq(agents.userId, userId) / eq(ctx.userId) / eq((t as typeof agents).userId, …)
const HUMAN_MISREAD =
  /eq\(\s*(?:\(t as typeof agents\)|agents)\.userId\s*,\s*(?:ctx\.)?userId\s*\)/;

describe("agent catalog owner-floor goes through ONE door (ownAdjunctFilter)", () => {
  for (const rel of READERS) {
    it(`${rel}: no raw agents.userId human-misread; uses ownAdjunctFilter`, () => {
      const src = read(rel);
      expect(
        HUMAN_MISREAD.test(src),
        `${rel}: floor via ownAdjunctFilter, not a raw agents.userId == caller comparison`
      ).toBe(false);
      expect(src).toMatch(/ownAdjunctFilter\(/);
    });
  }
});
