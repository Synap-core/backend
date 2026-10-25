/**
 * The goal's words, spelled once (review fixes, 2026-10-24): the verbs of a
 * goal's acts, the "Move to <status>" label, and the goal field labels both
 * apps and the CLI used to type by hand (slop.md, code-core F8/F10).
 */
import { describe, expect, it } from "vitest";
import {
  ACTION_VERBS,
  DECLARE_DONE_LABEL,
  GOAL_FIELD_LABELS,
  SERVES_LABEL,
  SPACE_BRIEF_FIELD_LABELS,
  THIS_WEEK_LABEL,
  resolveActionLabel,
  resolveGoalFieldLabel,
  resolveTrackMoveLabel,
} from "./index.js";
import { LENS_SECTION_LABELS } from "../lens/classes.js";
import { TRACK_COMMITMENT_MOVE_KEYS } from "../units/track-participants.js";
import { TRACK_STATUSES } from "../units/track.js";

describe("a goal's verbs", () => {
  it("opening a new version of a goal is its own verb; the governance reopen keeps its words", () => {
    expect(resolveActionLabel("track.reopen", "imperative")).toBe(
      "Open a new version"
    );
    expect(resolveActionLabel("track.reopen", "past")).toBe(
      "Opened a new version"
    );
    expect(resolveActionLabel("reopen", "imperative")).toBe("Reopen");
  });

  it("every commitment move, and the judge's and owner's answers, have a curated row in both moods", () => {
    const acts = [
      ...TRACK_COMMITMENT_MOVE_KEYS,
      "acknowledge",
      "send_back",
      "accept",
    ];
    expect(TRACK_COMMITMENT_MOVE_KEYS.length).toBeGreaterThanOrEqual(4); // non-vacuity
    for (const act of acts) {
      const row = ACTION_VERBS[act];
      expect(row, act).toBeDefined();
      expect(row!.imperative, act).not.toBe(row!.past);
    }
    expect(resolveActionLabel("report_impossible", "past")).toBe(
      "Reported impossible"
    );
    expect(resolveActionLabel("counter", "imperative")).toBe("Counter");
    expect(resolveActionLabel("send_back", "imperative")).toBe("Send back");
    expect(resolveActionLabel("accept", "imperative")).toBe("Accept");
  });

  it("a plain move names where it goes, in the status's own word, for every status", () => {
    expect(resolveTrackMoveLabel("agreed")).toBe("Move to agreed");
    // The stored token never leaks: `completed` reads "Closed".
    expect(resolveTrackMoveLabel("completed")).toBe("Move to closed");
    for (const s of TRACK_STATUSES) {
      expect(resolveTrackMoveLabel(s), s).toMatch(/^Move to [a-z ]+$/);
    }
    // Three different moves never share a label.
    const labels = TRACK_STATUSES.map(resolveTrackMoveLabel);
    expect(new Set(labels).size).toBe(TRACK_STATUSES.length);
    expect(resolveTrackMoveLabel(null)).toBe("");
  });
});

describe("a goal's field labels", () => {
  it("the end state is 'What done looks like'; 'Success looks like' stays the space brief's alone", () => {
    expect(GOAL_FIELD_LABELS.endState).toBe("What done looks like");
    const goalWords = new Set(
      Object.values(GOAL_FIELD_LABELS).map((w) => w.toLowerCase())
    );
    const shared = Object.values(SPACE_BRIEF_FIELD_LABELS).filter((l) =>
      goalWords.has(l.toLowerCase())
    );
    expect(shared).toEqual([]);
  });

  it("Done when is spelled once: the lens section reads the goal field's word", () => {
    expect(LENS_SECTION_LABELS.doneWhen).toBe(GOAL_FIELD_LABELS.criteria);
    expect(GOAL_FIELD_LABELS.criteria).toBe("Done when");
  });

  it("no two goal words are the same; page words are exported once", () => {
    const words = [
      ...Object.values(GOAL_FIELD_LABELS),
      SERVES_LABEL,
      THIS_WEEK_LABEL,
      DECLARE_DONE_LABEL,
    ].map((w) => w.toLowerCase());
    expect(new Set(words).size).toBe(words.length);
    expect([SERVES_LABEL, THIS_WEEK_LABEL, DECLARE_DONE_LABEL]).toEqual([
      "Serves",
      "This week's goals",
      "Declare done",
    ]);
  });

  it("a field resolves to its label; an unknown key humanizes", () => {
    expect(resolveGoalFieldLabel("dropConditions")).toBe("Drop it if");
    expect(resolveGoalFieldLabel("workKind")).toBe("Kind of work");
    expect(resolveGoalFieldLabel("loop_budget")).not.toBe("loop_budget");
    expect(resolveGoalFieldLabel(null)).toBe("");
  });
});
