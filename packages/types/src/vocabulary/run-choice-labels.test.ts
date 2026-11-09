/**
 * Run-choice words (who runs a playbook, slice 5a). Each row is pinned, the
 * map covers exactly the declared vias, and an unknown token never leaks.
 */
import { describe, expect, it } from "vitest";
import {
  RUN_CHOICE_PROVIDER_KEYS,
  RUN_CHOICE_VIAS,
} from "../agents/run-choice.js";
import {
  RUN_CHOICE_PROVIDER_KEY_LABELS,
  RUN_CHOICE_VIA_LABELS,
  SYNAP_AI_LABEL,
  SYNAP_CREDITS_LABEL,
  resolveRunChoiceHiddenLabel,
  resolveRunChoiceViaLabel,
  resolveSynapAiProviderLabel,
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

  it.each([
    [
      { name: "Anthropic", key: "person" },
      "Synap AI · using Anthropic (your key)",
    ],
    [
      { name: "Anthropic", key: "pod" },
      "Synap AI · using Anthropic (your key)",
    ],
    [
      { name: "OpenAI", key: "space" },
      "Synap AI · using OpenAI (this space's key)",
    ],
    [
      { name: SYNAP_CREDITS_LABEL, key: "synap" },
      "Synap AI · using Synap credits",
    ],
  ])("Synap AI with its provider %o → %s", (provider, words) => {
    expect(resolveSynapAiProviderLabel(provider)).toBe(words);
  });

  it("covers exactly the declared provider keys", () => {
    expect(Object.keys(RUN_CHOICE_PROVIDER_KEY_LABELS).sort()).toEqual(
      [...RUN_CHOICE_PROVIDER_KEYS].sort()
    );
  });

  it("the hidden line counts, and says nothing when nothing is hidden", () => {
    expect(resolveRunChoiceHiddenLabel(3)).toBe("3 more can't run now");
    expect(resolveRunChoiceHiddenLabel(0)).toBeNull();
  });
});
