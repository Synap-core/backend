/**
 * The two small reads of the needs-you leaf that are not row shaping: `×N`
 * (`repeatLabel`, kind-aware) and the session a group key names
 * (`sessionIdOfGroupKey`). The shaping rule itself is `needsYouRows`, pinned
 * in `needs-you-rows.test.ts` (the W2 `groupNeedsYou` it replaced is retired).
 */
import { describe, expect, it } from "vitest";
import { repeatLabel, sessionIdOfGroupKey } from "./index";

describe("repeatLabel", () => {
  it("draws ×N kind-aware (notification repeatCount, cluster count), nothing at 1", () => {
    // Kind-aware (W2 review): the field that means "repeat" differs per kind.
    expect(
      repeatLabel({ kind: "notification", count: 4, repeatCount: 4 })
    ).toBe("×4");
    expect(
      repeatLabel({ kind: "proposal-cluster", count: 3, repeatCount: 1 })
    ).toBe("×3");
    expect(
      repeatLabel({ kind: "notification", count: 1, repeatCount: 1 })
    ).toBeNull();
    expect(repeatLabel({})).toBeNull();
    // A draft-asks row's count is its DISTINCT asks — never "×3".
    expect(
      repeatLabel({ kind: "draft-asks", count: 3, repeatCount: 1 })
    ).toBeNull();
    // An owed slot is never a repeat, whatever a field says.
    expect(
      repeatLabel({ kind: "owed-slot", count: 2, repeatCount: 2 })
    ).toBeNull();
  });
});

describe("sessionIdOfGroupKey", () => {
  it("reads only session keys", () => {
    expect(sessionIdOfGroupKey("session:abc")).toBe("abc");
    expect(sessionIdOfGroupKey("session:")).toBeNull();
    expect(sessionIdOfGroupKey("proposal-cluster:abc")).toBeNull();
    expect(sessionIdOfGroupKey(null)).toBeNull();
  });
});
