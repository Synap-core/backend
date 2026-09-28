/**
 * Every notification type that can reach the `os` channel has a DECIDED push
 * rule in `@synap-core/types/push` — a category, the blocking-proposal rule, or
 * an explicit `null` ("in-app only, on purpose").
 *
 * Why: `classifyPush` answers `null` for a type it does not name, so a new
 * registry row that defaults to `os` would silently never push. That is the
 * SAFE default, but an undecided type is an accident nobody can date; this
 * makes the decision a line someone wrote.
 *
 * DERIVED: the scanned set is the registry itself, filtered on
 * `defaultChannels` — a new os type joins by existing.
 * Does NOT cover: a type whose `os` push is FORCED by a person's per-type
 * routing rule (any type can be); that path pushes without a category.
 */
import { describe, expect, it } from "vitest";
import { PUSH_TYPE_RULES } from "@synap-core/types/push";
import { NOTIFICATION_REGISTRY } from "./registry.js";

const OS_TYPES = NOTIFICATION_REGISTRY.filter(
  (d) =>
    d.defaultChannels.includes("os") &&
    (!d.channelCeiling || d.channelCeiling.includes("os"))
).map((d) => d.type);

describe("push classification covers every os-default type", () => {
  it("the scan sees a plausible set (non-vacuity)", () => {
    expect(OS_TYPES.length).toBeGreaterThanOrEqual(10);
    expect(OS_TYPES).toContain("session.needs_you");
    expect(OS_TYPES).toContain("proposal.created");
  });

  it("every os-default type is named in PUSH_TYPE_RULES", () => {
    const undecided = OS_TYPES.filter(
      (t) => !Object.prototype.hasOwnProperty.call(PUSH_TYPE_RULES, t)
    );
    expect(undecided).toEqual([]);
  });
});
