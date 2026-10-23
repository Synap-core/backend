import { describe, expect, it } from "vitest";
import { GOVERNANCE_POLICY_SENTENCES } from "@synap-core/types/proposals";
import { reasonMark, undoMark } from "./proposal-review-model";
import { initials } from "../../_lib/object/provenance-chips";

describe("reasonMark — WHY it waits, as one mark, only when it is particular", () => {
  it("names the reason, not the ladder's reach; the sentence rides behind it", () => {
    expect(reasonMark("POSSIBLE_DUPLICATE")).toEqual({
      tone: "warning",
      label: "Possible duplicate",
      sentence: GOVERNANCE_POLICY_SENTENCES.POSSIBLE_DUPLICATE,
    });
  });

  it("a floor or an ambiguous code warns", () => {
    expect(reasonMark("SCOPE_IDENTITY_CHANGE")?.tone).toBe("warning");
    expect(reasonMark("CHANNEL_PROPOSE")?.tone).toBe("warning");
  });

  it("a reason that only restates 'this waits for you' draws no mark", () => {
    expect(reasonMark("WRITES_REQUIRE_PROPOSAL")).toBeNull();
    expect(reasonMark("GOVERNANCE_RULE")).toBeNull();
    expect(reasonMark("HUMAN_GATE")).toBeNull();
  });

  it("absent, unknown and inherited names draw no mark", () => {
    expect(reasonMark("toString")).toBeNull();
    expect(reasonMark(null)).toBeNull();
  });
});

describe("undoMark — undo is the default, so only its absence is marked", () => {
  it("draws nothing for an undoable or unknown change", () => {
    expect(undoMark(true)).toBeNull();
    expect(undoMark(undefined)).toBeNull();
    expect(undoMark(null)).toBeNull();
  });

  it("marks the pod's own `revertable: false`", () => {
    expect(undoMark(false)?.label).toBe("Can't be undone");
  });
});

describe("initials", () => {
  it("first and last word, or the first two letters of one", () => {
    expect(initials("Ada King Lovelace")).toBe("AL");
    expect(initials("claude")).toBe("CL");
    expect(initials("  ")).toBe("?");
  });
});
