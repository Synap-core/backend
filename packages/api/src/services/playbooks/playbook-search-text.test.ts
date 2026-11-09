/**
 * The ONE definition of what a playbook is matched on, and how its description
 * is shown to an agent (`playbook-search-text.ts`). The two doors that rank
 * playbooks read it: `matchSessionTemplate` (synap_find, start_session) and
 * `matchPlaybooks` (synap_match_playbooks); their own tests drive the value
 * through each door.
 */
import { describe, expect, it } from "vitest";
import {
  PLAYBOOK_DESCRIPTION_CAP,
  playbookDescriptionPreview,
  playbookSearchText,
} from "./playbook-search-text.js";

describe("playbookSearchText", () => {
  it("is the description, the goal and every stage name", () => {
    expect(
      playbookSearchText({
        description: "Turn a take into a reel",
        goalTemplate: "Run the passes",
        stages: [{ name: "Transcribe" }, { name: "Cut" }, { goal: "no name" }],
      })
    ).toEqual([
      "Turn a take into a reel",
      "Run the passes",
      "Transcribe",
      "Cut",
    ]);
  });

  it("an absent field is an empty word list, never the string 'null'", () => {
    expect(
      playbookSearchText({
        description: null,
        goalTemplate: null,
        stages: null,
      })
    ).toEqual(["", ""]);
  });
});

describe("playbookDescriptionPreview", () => {
  it("absent when there is no description, so the row carries no key", () => {
    expect(playbookDescriptionPreview(null)).toBeUndefined();
    expect(playbookDescriptionPreview("  \n ")).toBeUndefined();
  });

  it("folds whitespace and keeps a short one whole", () => {
    expect(playbookDescriptionPreview("Edit  my\n\nrecording ")).toBe(
      "Edit my recording"
    );
  });

  it("cuts a long one at a word under the cap, with an ellipsis", () => {
    const long = "word ".repeat(200);
    const cut = playbookDescriptionPreview(long)!;
    expect(cut.endsWith("word…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(PLAYBOOK_DESCRIPTION_CAP + 1);
    expect(cut.length).toBeGreaterThan(PLAYBOOK_DESCRIPTION_CAP / 2);
  });

  it("cuts a single unbroken run at the cap rather than to nothing", () => {
    const cut = playbookDescriptionPreview("x".repeat(1000))!;
    expect(cut).toBe(`${"x".repeat(PLAYBOOK_DESCRIPTION_CAP)}…`);
  });
});
