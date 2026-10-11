/**
 * THE FOCUS RULE — one lead + one primary per state, shared by browser + relay.
 *
 * Discriminating rows (where a plausible wrong rule disagrees):
 *   - needs_you AND a grade owed ⇒ Needs you leads (grade-first is the
 *     plausible inversion — the same row `lead.test.ts` pins);
 *   - needs_review (pending proposals) ⇒ Needs you, NOT Done means (reading
 *     the unit state's name as "a grade is owed" is the wrong rule);
 *   - a lead the host omitted ⇒ the fixed order stands (moving it anyway
 *     would resurrect an OMIT section).
 */

import { describe, expect, it } from "vitest";
import { UNIT_STATES } from "../units/state.js";
import { resolveWorkLead } from "../units/lead.js";
import { resolveActionLabel } from "../vocabulary/index.js";
import type { TrackMoveOn } from "../units/track-step.js";
import { LENS_SECTION_ORDER } from "./classes.js";
import type { LensNextMove } from "./header.js";
import {
  lensFocus,
  lensFocusOrder,
  lensFocusSections,
  trackStepFocusState,
  SESSION_STEP_SECTIONS,
} from "./focus.js";

const ask: LensNextMove = {
  section: "blocking",
  state: {
    state: "needs_you",
    tone: "primary",
    glyph: "person",
    rail: { kind: "determinate", pct: 0 },
  },
  reason: "Waiting on you",
  text: "Answer: backup target",
  verb: { action: "answer", label: "Answer" },
  door: { kind: "owed", id: "s1:slot" },
};

const moveOn = (over: Partial<TrackMoveOn> = {}): TrackMoveOn => ({
  next: { key: "draft", name: "Draft", gate: null },
  offered: true,
  enabled: true,
  missing: [],
  block: null,
  ...over,
});

describe("lensFocus — what you HOLD outranks what you judge", () => {
  it("THE DISCRIMINATING ROW: needs_you AND a grade owed ⇒ Needs you, the ask's own verb", () => {
    const f = lensFocus({
      scope: "session",
      state: "needs_you",
      gradeOwed: true,
      nextMove: ask,
    });
    expect(f.lead).toBe("blocking");
    expect(f.primary).toEqual({
      verb: ask.verb,
      target: { kind: "door", door: ask.door },
    });
  });

  it("a grade owed ⇒ Done means leads, Accept · Send back", () => {
    const f = lensFocus({
      scope: "session",
      state: "working",
      gradeOwed: true,
    });
    expect(f.lead).toBe("doneMeans");
    expect(f.primary?.verb).toEqual({ action: "accept", label: "Accept" });
    expect(f.secondary?.verb).toEqual({
      action: "send_back",
      label: "Send back",
    });
    expect(f.primary?.target).toEqual({ kind: "grade" });
  });

  it("on a track, a grade owed leads the step card (structure)", () => {
    expect(
      lensFocus({ scope: "track", state: "working", gradeOwed: true }).lead
    ).toBe("structure");
  });

  it("needs_review is PENDING PROPOSALS ⇒ Needs you, not Done means", () => {
    const f = lensFocus({
      scope: "session",
      state: "needs_review",
      nextMove: { ...ask, verb: { action: "approve", label: "Approve" } },
    });
    expect(f.lead).toBe("blocking");
    expect(f.primary?.verb.label).toBe("Approve");
  });

  it("an ask with no door (or a happening next move) draws no primary — never a dead button", () => {
    expect(
      lensFocus({
        scope: "session",
        state: "needs_you",
        nextMove: { ...ask, door: null },
      }).primary
    ).toBeNull();
    expect(
      lensFocus({
        scope: "session",
        state: "needs_you",
        nextMove: { ...ask, section: "happening" },
      }).primary
    ).toBeNull();
  });
});

describe("lensFocus — the rest of the table", () => {
  it("working ⇒ Happening, Message the room", () => {
    const f = lensFocus({ scope: "session", state: "working" });
    expect(f).toEqual({
      lead: "happening",
      primary: {
        verb: { action: "message", label: "Message" },
        target: { kind: "room" },
      },
      secondary: null,
    });
  });

  it("blocked ⇒ no lead, Open the blocker; no blocker door ⇒ no primary", () => {
    const door = { kind: "session", id: "b1" };
    expect(
      lensFocus({ scope: "session", state: "blocked", blockedBy: door })
    ).toEqual({
      lead: null,
      primary: {
        verb: { action: "open", label: "Open" },
        target: { kind: "door", door },
      },
      secondary: null,
    });
    expect(
      lensFocus({ scope: "session", state: "blocked" }).primary
    ).toBeNull();
  });

  it("not_started ⇒ From earlier steps (track: the step card), Start a stage", () => {
    const f = lensFocus({
      scope: "session",
      state: "not_started",
      stageKey: "draft",
    });
    expect(f.lead).toBe("earlierSteps");
    expect(f.primary).toEqual({
      verb: { action: "start", label: "Start" },
      target: { kind: "start-step", stageKey: "draft" },
    });
    expect(lensFocus({ scope: "track", state: "not_started" })).toEqual({
      lead: "structure",
      primary: null,
      secondary: null,
    });
  });

  it("done ⇒ Produced on a session (no primary); on a track the step card + Move on", () => {
    expect(
      lensFocus({ scope: "session", state: "done", moveOn: moveOn() })
    ).toEqual({ lead: "produced", primary: null, secondary: null });
    const f = lensFocus({
      scope: "track",
      state: "done",
      moveOn: moveOn({
        enabled: false,
        missing: ["Brief approved"],
        block: "criteria_unmet",
      }),
    });
    expect(f.lead).toBe("structure");
    expect(f.primary).toEqual({
      verb: { action: "move_on", label: "Move on" },
      target: {
        kind: "move-on",
        next: { key: "draft", name: "Draft" },
        enabled: false,
        missing: ["Brief approved"],
      },
    });
  });

  it("done on a track whose Move on is not offered (last step / closed) ⇒ no primary", () => {
    expect(
      lensFocus({
        scope: "track",
        state: "done",
        moveOn: moveOn({ offered: false, next: null, block: "last_step" }),
      }).primary
    ).toBeNull();
    expect(lensFocus({ scope: "track", state: "done" }).primary).toBeNull();
  });

  it("failed ⇒ no lead (the alert block already leads), Open the run", () => {
    const door = { kind: "run", id: "r1" };
    expect(
      lensFocus({ scope: "session", state: "failed", failedRun: door }).primary
        ?.target
    ).toEqual({ kind: "door", door });
    expect(lensFocus({ scope: "session", state: "failed" }).lead).toBeNull();
  });

  it.each([
    "paused",
    "scheduled",
    "unmeasured",
    "frobnicated",
    null,
    undefined,
  ])("%s ⇒ the fixed order, no primary", (state) => {
    expect(
      lensFocus({
        scope: "session",
        state,
        nextMove: ask,
        blockedBy: { kind: "x", id: "y" },
      })
    ).toEqual({ lead: null, primary: null, secondary: null });
  });

  it("every verb is the vocabulary's imperative", () => {
    for (const state of [...UNIT_STATES, "x"]) {
      for (const gradeOwed of [false, true]) {
        const f = lensFocus({
          scope: "track",
          state,
          gradeOwed,
          nextMove: ask,
          blockedBy: { kind: "s", id: "1" },
          failedRun: { kind: "r", id: "1" },
          stageKey: "k",
          moveOn: moveOn(),
        });
        for (const a of [f.primary, f.secondary]) {
          if (a)
            expect(a.verb.label).toBe(
              resolveActionLabel(a.verb.action, "imperative")
            );
        }
      }
    }
  });
});

describe("ONE lead rule: lensFocus agrees with resolveWorkLead on every state", () => {
  // Derived from UNIT_STATES: a new state joins this loop by existing.
  it("needs_you ⇔ owed; a grade owed ⇔ scorecard — at both scopes", () => {
    expect(UNIT_STATES.length).toBeGreaterThanOrEqual(10);
    for (const scope of ["session", "track"] as const) {
      for (const state of [...UNIT_STATES, "unknown-state"]) {
        for (const gradeOwed of [false, true]) {
          const work = resolveWorkLead({
            owedCount: state === "needs_you" ? 1 : 0,
            gradeOwed,
          });
          const f = lensFocus({ scope, state, gradeOwed });
          const gradeLead = f.primary?.target.kind === "grade";
          expect({
            state,
            gradeOwed,
            scope,
            owed: state === "needs_you" && f.lead === "blocking",
            grade: gradeLead,
          }).toEqual({
            state,
            gradeOwed,
            scope,
            owed: work === "owed",
            grade: work === "scorecard",
          });
        }
      }
    }
  });
});

describe("the sections and the order", () => {
  it("a session draws its step sections in the structure place, after Produced", () => {
    expect(lensFocusSections("session")).toEqual([
      "blocking",
      "happening",
      "produced",
      ...SESSION_STEP_SECTIONS,
      "proposed",
      "happened",
    ]);
    expect(lensFocusSections("track")).toEqual(
      LENS_SECTION_ORDER.filter((s) => s !== "data")
    );
  });

  it("every lead the rule can return is a section of its scope", () => {
    for (const scope of ["session", "track"] as const) {
      const sections = lensFocusSections(scope);
      for (const state of UNIT_STATES) {
        for (const gradeOwed of [false, true]) {
          const { lead } = lensFocus({ scope, state, gradeOwed });
          if (lead !== null) expect(sections).toContain(lead);
        }
      }
    }
  });

  it("the lead moves first; the rest keep the fixed order", () => {
    expect(lensFocusOrder(lensFocusSections("session"), "doneMeans")).toEqual([
      "doneMeans",
      "blocking",
      "happening",
      "produced",
      "earlierSteps",
      "proposed",
      "happened",
    ]);
  });

  it("a lead the host omitted changes nothing — reordering never resurrects", () => {
    const drawn = ["happening", "produced", "happened"] as const;
    expect(lensFocusOrder(drawn, "blocking")).toEqual([...drawn]);
    expect(lensFocusOrder(drawn, null)).toEqual([...drawn]);
  });
});

describe("trackStepFocusState — the selected step's state, one derivation", () => {
  it("a step behind the track is done; one ahead is not started", () => {
    expect(trackStepFocusState({ position: "done" }, null, "working")).toBe(
      "done"
    );
    expect(
      trackStepFocusState({ position: "not_started" }, moveOn(), "needs_you")
    ).toBe("not_started");
  });

  it("the current step with criteria met (Move on enabled) reads done", () => {
    expect(
      trackStepFocusState({ position: "active" }, moveOn(), "working")
    ).toBe("done");
  });

  it("criteria unmet or not offered ⇒ the track's own state", () => {
    expect(
      trackStepFocusState(
        { position: "active" },
        moveOn({ enabled: false }),
        "working"
      )
    ).toBe("working");
    expect(
      trackStepFocusState(
        { position: "active" },
        moveOn({ offered: false }),
        "paused"
      )
    ).toBe("paused");
    expect(trackStepFocusState({ position: "active" }, null, null)).toBeNull();
  });

  it("what you HOLD outranks moving on: needs_you / failed / blocked stay", () => {
    for (const s of ["needs_you", "failed", "blocked"]) {
      expect(trackStepFocusState({ position: "active" }, moveOn(), s)).toBe(s);
    }
  });
});
