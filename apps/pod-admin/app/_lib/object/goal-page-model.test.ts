import { describe, expect, it } from "vitest";
import type { GoalMarkView } from "@synap-core/types/goal";
import { goalPill, goalSessionRows, goalWriteNotice } from "./goal-page-model";

const mark = (tone: GoalMarkView["tone"]): GoalMarkView => ({
  state: "x",
  tone,
  glyph: "check",
  label: "Label",
});

describe("goalPill — a goal mark as a console pill", () => {
  it("maps the shared tones onto the four pill kinds", () => {
    expect(goalPill(mark("success")).kind).toBe("healthy");
    expect(goalPill(mark("primary")).kind).toBe("healthy");
    expect(goalPill(mark("warning")).kind).toBe("stale");
    expect(goalPill(mark("error")).kind).toBe("down");
  });

  it("a quiet ending (retired, dropped) is grey, never healthy", () => {
    expect(goalPill(mark("textMuted")).kind).toBe("unknown");
    expect(goalPill(mark("textSecondary")).kind).toBe("unknown");
  });

  it("keeps the mark's own words", () => {
    expect(goalPill(mark("success")).label).toBe("Label");
  });
});

describe("goalSessionRows", () => {
  it("names a session by its title, else its goal's first line", () => {
    const rows = goalSessionRows([
      { id: "a", status: "active", title: "Named", goal: "ignored" },
      { id: "b", status: "closed", title: null, goal: "First line\nmore" },
    ]);
    expect(rows.map((r) => r.title)).toEqual(["Named", "First line"]);
    expect(rows[1]!.status?.label).toBeTruthy();
  });
});

describe("goalWriteNotice — how a write answered, said once", () => {
  it("a proposed write is a success held for review, with its proposal", () => {
    expect(
      goalWriteNotice("Paused.", {
        outcome: "proposed",
        proposalId: "p-1",
        goalId: null,
      })
    ).toEqual({
      title: "Proposed for review — it applies once approved.",
      proposalId: "p-1",
    });
  });

  it("an unchanged write never says it did something", () => {
    expect(
      goalWriteNotice("Paused.", {
        outcome: "unchanged",
        proposalId: null,
        goalId: null,
      }).title
    ).toBe("Nothing to change — it already was.");
  });

  it("an applied write says the act", () => {
    expect(
      goalWriteNotice("Accepted.", {
        outcome: "updated",
        proposalId: null,
        goalId: "g",
      }).title
    ).toBe("Accepted.");
  });
});
