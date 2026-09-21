import { describe, it, expect } from "vitest";
import {
  resolveUnitState,
  describeCadence,
  UNIT_STATES,
  type UnitStateInput,
} from "./state.js";

/**
 * The ONE derivation of a unit of work's state. These assert the ORDER as
 * much as the outcomes, because order is where this kind of rule goes wrong:
 * an "unknown" placed one rung too high silences a live, actionable answer.
 */
const base: UnitStateInput = {
  terminal: false,
  failed: false,
  checkGate: false,
  owedFromYou: 0,
  pendingDecisions: 0,
  blockedBy: null,
  running: false,
  schedule: null,
  everStarted: true,
  progress: null,
  unreadable: false,
};

describe("resolveUnitState — precedence", () => {
  it("failure outranks everything, including a paused check", () => {
    expect(
      resolveUnitState({ ...base, failed: true, checkGate: true }).state
    ).toBe("failed");
  });

  it("a closed unit is done even with work still owed on it", () => {
    expect(
      resolveUnitState({ ...base, terminal: true, owedFromYou: 3 }).state
    ).toBe("done");
  });

  it("an ANSWER you owe outranks a JUDGEMENT you owe", () => {
    // Both are your turn; the one that unblocks the machine comes first.
    expect(
      resolveUnitState({ ...base, owedFromYou: 1, pendingDecisions: 2 }).state
    ).toBe("needs_you");
  });

  it("a decision you can take outranks a blocker you can only wait on", () => {
    expect(
      resolveUnitState({
        ...base,
        pendingDecisions: 1,
        blockedBy: "Pricing sign-off",
      }).state
    ).toBe("needs_review");
  });

  it("being blocked outranks the agent running", () => {
    expect(
      resolveUnitState({ ...base, blockedBy: "Legal", running: true }).state
    ).toBe("blocked");
  });

  it("a schedule only shows when nothing live is happening", () => {
    const sched = { cron: "0 8 * * *", enabled: true };
    expect(resolveUnitState({ ...base, schedule: sched }).state).toBe(
      "scheduled"
    );
    expect(
      resolveUnitState({ ...base, schedule: sched, running: true }).state
    ).toBe("working");
  });

  it("a disabled schedule is paused, not scheduled", () => {
    expect(
      resolveUnitState({
        ...base,
        schedule: { cron: "0 9 * * 1", enabled: false },
      }).state
    ).toBe("paused");
  });
});

describe("resolveUnitState — an unknown removes only the NEGATIVE", () => {
  it("an unreadable pack is `unmeasured`, never `done`", () => {
    expect(resolveUnitState({ ...base, pendingDecisions: null }).state).toBe(
      "unmeasured"
    );
    expect(resolveUnitState({ ...base, unreadable: true }).state).toBe(
      "unmeasured"
    );
  });

  it("THE PLACEMENT ROW: it never silences a live answer", () => {
    // If `unmeasured` sat above the actionable arms, a slow or failed
    // proposals read would hide a paused check and a blocker — both of which
    // are true and actionable whatever the pack did.
    expect(
      resolveUnitState({ ...base, unreadable: true, checkGate: true }).state
    ).toBe("needs_you");
    expect(
      resolveUnitState({ ...base, pendingDecisions: null, blockedBy: "X" })
        .state
    ).toBe("blocked");
    expect(
      resolveUnitState({ ...base, unreadable: true, failed: true }).state
    ).toBe("failed");
  });

  it("zero and unreadable are DIFFERENT FACTS", () => {
    // The discriminating pair this whole module exists for.
    expect(resolveUnitState({ ...base, pendingDecisions: 0 }).state).not.toBe(
      "unmeasured"
    );
    expect(resolveUnitState({ ...base, pendingDecisions: null }).state).toBe(
      "unmeasured"
    );
  });
});

describe("resolveUnitState — the rail", () => {
  it("a unit that never started has NO rail — a rail implies motion", () => {
    const r = resolveUnitState({ ...base, everStarted: false }).rail;
    expect(r.kind).toBe("none");
    expect(r.pct).toBeNull();
  });

  it("working without a measure is striped, never a fake 0%", () => {
    const r = resolveUnitState({ ...base, running: true }).rail;
    expect(r.kind).toBe("striped");
    expect(r.pct).toBeNull();
  });

  it("working WITH a measure is determinate and rounds honestly", () => {
    const r = resolveUnitState({
      ...base,
      running: true,
      progress: { done: 9, total: 14 },
    }).rail;
    expect(r.kind).toBe("determinate");
    expect(r.pct).toBe(64);
  });

  it("scheduled and unmeasured are dashed — progress that is not real yet", () => {
    expect(
      resolveUnitState({
        ...base,
        schedule: { cron: "0 8 * * *", enabled: true },
      }).rail.kind
    ).toBe("dashed");
    expect(resolveUnitState({ ...base, unreadable: true }).rail.kind).toBe(
      "dashed"
    );
  });

  it("a total of zero is not measurable, and does not become 0%", () => {
    const r = resolveUnitState({
      ...base,
      running: true,
      progress: { done: 0, total: 0 },
    }).rail;
    expect(r.kind).toBe("striped");
  });

  it("pct is null unless the rail is determinate", () => {
    for (const s of [
      resolveUnitState({ ...base, everStarted: false }),
      resolveUnitState({ ...base, running: true }),
      resolveUnitState({ ...base, unreadable: true }),
    ]) {
      expect(s.rail.pct).toBeNull();
    }
  });
});

describe("resolveUnitState — tones stay inside the palette", () => {
  const ALLOWED = new Set([
    "primary",
    "ai",
    "info",
    "error",
    "success",
    "textSecondary",
    "textMuted",
  ]);

  it("every reachable state resolves to an existing token", () => {
    const seen = new Set<string>();
    const cases: UnitStateInput[] = [
      { ...base, failed: true },
      { ...base, terminal: true },
      { ...base, checkGate: true },
      { ...base, pendingDecisions: 1 },
      { ...base, blockedBy: "X" },
      { ...base, running: true },
      { ...base, schedule: { cron: "0 8 * * *", enabled: true } },
      { ...base, schedule: { cron: "0 8 * * *", enabled: false } },
      { ...base, unreadable: true },
      { ...base, everStarted: false },
      { ...base },
    ];
    for (const c of cases) {
      const v = resolveUnitState(c);
      expect(ALLOWED.has(v.tone)).toBe(true);
      seen.add(v.state);
    }
    // NON-VACUITY: the cases above must actually reach every declared state,
    // or this suite is asserting tones for a handful of them.
    for (const s of UNIT_STATES) expect(seen.has(s)).toBe(true);
  });

  it("an ANSWER and a JUDGEMENT share the tone and differ by glyph", () => {
    const answer = resolveUnitState({ ...base, owedFromYou: 1 });
    const judge = resolveUnitState({ ...base, pendingDecisions: 1 });
    expect(answer.tone).toBe(judge.tone);
    expect(answer.glyph).not.toBe(judge.glyph);
  });
});

describe("describeCadence", () => {
  it("reads the shapes the pod actually stores", () => {
    expect(describeCadence({ cron: "0 8 * * *", enabled: true })).toBe(
      "Daily 08:00"
    );
    expect(describeCadence({ cron: "0 9 * * 1", enabled: false })).toBe(
      "Mon 09:00"
    );
    expect(describeCadence({ cron: "0 */6 * * *", enabled: true })).toBe(
      "Every 6h"
    );
  });

  it("hands back the raw cron rather than guessing", () => {
    // A confidently wrong cadence is worse than one that admits it is a cron.
    expect(describeCadence({ cron: "15 3 2 4 *", enabled: true })).toBe(
      "15 3 2 4 *"
    );
    expect(describeCadence({ cron: "nonsense", enabled: true })).toBe(
      "nonsense"
    );
  });

  it("no schedule is null, not a label", () => {
    expect(describeCadence(null)).toBeNull();
    expect(describeCadence(undefined)).toBeNull();
  });
});
