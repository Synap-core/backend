import { describe, expect, it } from "vitest";
import { GOVERNANCE_POLICY_SENTENCES } from "@synap-core/types/proposals";
import { reasonMark, undoMark } from "./proposal-review-model";
import { initials } from "../../_lib/object/provenance-chips";

describe("reasonMark — WHY it waits, as one mark", () => {
  it("names the reason, not the ladder's reach; the sentence rides behind it", () => {
    expect(reasonMark("POSSIBLE_DUPLICATE", undefined)).toEqual({
      tone: "warning",
      label: "Possible duplicate",
      sentence: GOVERNANCE_POLICY_SENTENCES.POSSIBLE_DUPLICATE,
    });
  });

  it("tones by reach: a floor warns, your rule is primary, the default is quiet", () => {
    expect(reasonMark("SCOPE_IDENTITY_CHANGE", undefined)?.tone).toBe(
      "warning"
    );
    // An ambiguous code fails closed, like the ladder.
    expect(reasonMark("CHANNEL_PROPOSE", undefined)?.tone).toBe("warning");
    expect(reasonMark("GOVERNANCE_RULE", undefined)?.tone).toBe("primary");
    expect(reasonMark("WRITES_REQUIRE_PROPOSAL", undefined)?.tone).toBe(
      "default"
    );
  });

  it("a legacy row with only its sentence still gets one mark; nothing gets none", () => {
    expect(
      reasonMark(null, "Agent requires proposal for all write operations.")
    ).toEqual({
      tone: "default",
      label: "Why it waits",
      sentence: "Agent requires proposal for all write operations.",
    });
    expect(reasonMark("toString", undefined)).toBeNull();
    expect(reasonMark(null, undefined)).toBeNull();
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
