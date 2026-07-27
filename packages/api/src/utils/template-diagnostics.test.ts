import { describe, it, expect } from "vitest";
import { authoringMisses, type TemplateMiss } from "./template-diagnostics.js";

const miss = (
  name: string,
  kind: TemplateMiss["kind"],
  count = 1
): TemplateMiss => ({ name, kind, count });

describe("authoringMisses — what is worth telling a human about", () => {
  it("keeps the misses an author can fix", () => {
    const misses = [
      miss("competitor", "unknown-arg"),
      miss("ourSpace", "literal-brace"),
      miss("e9", "unresolved-entity"),
    ];
    expect(authoringMisses(misses)).toEqual(misses);
  });

  it("drops context misses — the SURFACE decides whether context exists", () => {
    // `@{context:url}` is legitimately empty on every non-browser surface (CLI,
    // agent, automation) and resolveGoal never supplies context at all. Warning
    // on those means warning on the canonical happy path, which is how a panel
    // becomes noise. Grammar #3 learned this the same way.
    expect(
      authoringMisses([
        miss("context:url", "unresolved-context"),
        miss("selection", "unresolved-context"),
        miss("gone", "unknown-arg"),
      ])
    ).toEqual([miss("gone", "unknown-arg")]);
  });

  it("leaves an all-context miss list empty rather than half-reported", () => {
    expect(
      authoringMisses([miss("context:text", "unresolved-context")])
    ).toEqual([]);
  });
});
