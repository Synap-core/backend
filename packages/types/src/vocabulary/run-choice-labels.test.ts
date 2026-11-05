/**
 * Run-choice words (who runs a playbook, slice 5a). Each row is pinned, the
 * map covers exactly the declared vias, and an unknown token never leaks.
 */
import { describe, expect, it } from "vitest";
import { RUN_CHOICE_VIAS } from "../agents/run-choice.js";
import {
  RUN_CHOICE_VIA_LABELS,
  SYNAP_AI_LABEL,
  resolveRunChoiceViaLabel,
} from "./index.js";

describe("run choice words", () => {
  it.each([
    ["named", "Chosen for this run"],
    ["stored", "Your choice"],
    ["fallback", "Your agent couldn't take it"],
    ["default", "The process's default"],
  ])("%s → %s", (via, words) => {
    expect(resolveRunChoiceViaLabel(via)).toBe(words);
  });

  it("covers exactly the declared vias", () => {
    expect(Object.keys(RUN_CHOICE_VIA_LABELS).sort()).toEqual(
      [...RUN_CHOICE_VIAS].sort()
    );
  });

  it("an unknown via humanizes, an absent one is empty", () => {
    expect(resolveRunChoiceViaLabel("some_new_via")).toBe("Some new via");
    expect(resolveRunChoiceViaLabel(null)).toBe("");
  });

  it("names Synap AI once", () => {
    expect(SYNAP_AI_LABEL).toBe("Synap AI");
  });
});
