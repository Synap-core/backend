/**
 * The roll-up a link declares (plan 7d71ddcc W3): its closed declaration, the
 * decision D5 (lost parts are ignored, at least one part must be done) and
 * the parent's target status. Pure.
 *
 * NEGATIVE CONTROL: the `-negctl` branch counts a lost part as open; "a lost
 * part is ignored" then fails (the parent never rolls up).
 */
import { describe, expect, it } from "vitest";
import {
  readRelationReactions,
  rollupProgress,
  rollupProgressLabel,
  rollupTarget,
} from "./reactions.js";

const done = { status: "published", category: "done" as const };
const lost = { status: "dropped", category: "lost" as const };
const open = { status: "writing", category: "active" as const };

describe("readRelationReactions — a closed union", () => {
  it("reads a roll-up and keeps only its typed fields", () => {
    const r = readRelationReactions({
      cardinality: "many-to-one",
      reactions: [
        { kind: "rollup", to: "complete", chains: true, extra: "dropped" },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.declarations).toEqual([
      { kind: "rollup", to: "complete", chains: true },
    ]);
  });

  it("reports an unknown kind, a bad end and a second roll-up; reads nothing on none", () => {
    const r = readRelationReactions({
      reactions: [
        { kind: "cascade" },
        { kind: "rollup", parent: "sideways" },
        { kind: "rollup" },
        { kind: "rollup", terminal: "apply" },
      ],
    });
    expect(r.declarations).toEqual([{ kind: "rollup" }]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toMatch(/"cascade" is not a kind/);
    expect(readRelationReactions({ cardinality: "x" })).toEqual({
      declarations: [],
      errors: [],
    });
    expect(readRelationReactions(null).declarations).toEqual([]);
  });
});

describe("rollupProgress — decision D5", () => {
  it("a lost part is ignored: the rest done → ready", () => {
    const p = rollupProgress([done, lost, done]);
    expect(p).toEqual({ of: 2, done: 2, lost: 1, open: 0, ready: true });
    expect(rollupProgressLabel(p)).toBe("2 of 2 done · 1 dropped");
  });

  it("at least one part must be done: all lost → not ready", () => {
    expect(rollupProgress([lost, lost]).ready).toBe(false);
    expect(rollupProgress([]).ready).toBe(false);
  });

  it("an open part holds the parent", () => {
    const p = rollupProgress([done, open, lost]);
    expect(p.ready).toBe(false);
    expect(rollupProgressLabel(p)).toBe("1 of 2 done · 1 dropped");
  });

  it("an unknown status is open; a part with no status at all is not counted", () => {
    expect(
      rollupProgress([done, { status: "mystery", category: null }]).ready
    ).toBe(false);
    expect(
      rollupProgress([done, { status: null, category: null }])
    ).toMatchObject({ of: 1, done: 1, ready: true });
  });
});

describe("rollupTarget — where the parent goes", () => {
  const options = [
    { key: "draft", category: "open" as const },
    { key: "cancelled", category: "lost" as const },
    { key: "live", category: "active" as const },
    { key: "complete", category: "done" as const },
  ];

  it("the declared status, else the next one that is not lost", () => {
    expect(rollupTarget({ options, current: "draft", to: "complete" })).toBe(
      "complete"
    );
    expect(rollupTarget({ options, current: "draft" })).toBe("live");
    expect(rollupTarget({ options, current: "live" })).toBe("complete");
  });

  it("a parent that already ended, or a status it does not declare, goes nowhere", () => {
    expect(rollupTarget({ options, current: "complete" })).toBeNull();
    expect(rollupTarget({ options, current: "cancelled" })).toBeNull();
    expect(
      rollupTarget({ options, current: "draft", to: "shipped" })
    ).toBeNull();
  });
});
