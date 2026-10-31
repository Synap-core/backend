/**
 * TRIPWIRE — the wait kinds (decision 2, report c3a662b2 §3) and the ONE map
 * table that gives them.
 *
 * Pins:
 *  - `WAIT_KINDS` is exactly the taxonomy's names, in its order: a kind added
 *    or renamed here is a decision, not a refactor;
 *  - every value of every axis of `WAIT_KIND_FROM` maps to a real kind, and
 *    the mapping FUNCTION (`waitKindOf`) is driven, not only the table read;
 *  - the axis is never called `kind` (three `kind` fields already exist):
 *    every carrier spells it `waitKind`;
 *  - the two new unit states: a wait whose ball is `them` reads "With them",
 *    one whose ball is `machine` reads "On a machine".
 *
 * The slot reasons (`BLOCKED_REASONS`, `@synap/playbooks`) and the hold
 * values row by row are pinned in `api/__tripwires__/waiting-on-*.test.ts`,
 * where both closed sets can be imported.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOLD_ON } from "../lifecycle/hold.js";
import {
  WAIT_KINDS,
  WAIT_BALLS,
  WAIT_KIND_BALL,
  WAIT_KIND_FROM,
  isWaitKind,
  waitKindBall,
  type WaitKind,
} from "./wait-kind.js";
import { deriveWaitingOn, waitKindOf, type WaitingOnSource } from "./goal.js";
import { resolveUnitState, UNIT_STATES } from "./state.js";
import { waitingOnRefView } from "../goal/marks.js";
import {
  WAIT_KIND_LABELS,
  resolveStatusLabel,
  resolveWaitKindLabel,
} from "../vocabulary/index.js";

/** The decision, spelled out once more on purpose: a change here is a decision. */
const DECIDED_KINDS = [
  "answer",
  "approval",
  "send",
  "try_it",
  "access",
  "decide",
  "their_reply",
  "their_document",
  "signature",
  "payment",
  "vendor",
  "agent_work",
  "agent_stopped",
  "ci",
  "devbox_job",
  "merge_queue",
  "red_main",
  "deploy",
  "another_work",
  "date",
  "nobody",
];

describe("WAIT_KINDS", () => {
  it("is the decided taxonomy, in order", () => {
    expect([...WAIT_KINDS]).toEqual(DECIDED_KINDS);
  });

  it("every kind has a ball and words, and the tables name nothing else", () => {
    expect(Object.keys(WAIT_KIND_BALL).sort()).toEqual([...WAIT_KINDS].sort());
    expect(Object.keys(WAIT_KIND_LABELS).sort()).toEqual(
      [...WAIT_KINDS].sort()
    );
    for (const k of WAIT_KINDS) {
      expect(WAIT_BALLS).toContain(WAIT_KIND_BALL[k]);
      expect(resolveWaitKindLabel(k)).toBe(WAIT_KIND_LABELS[k]);
    }
  });

  it("an unknown kind is no kind: no ball, humanized words", () => {
    expect(isWaitKind("kind")).toBe(false);
    expect(waitKindBall("nope")).toBeNull();
    expect(waitKindBall(null)).toBeNull();
    expect(resolveWaitKindLabel("some_new_kind")).toBe("Some new kind");
  });
});

describe("the one map table → waitKind", () => {
  it("every row of every axis is a real kind", () => {
    for (const axis of Object.values(WAIT_KIND_FROM)) {
      for (const k of Object.values(axis)) expect(isWaitKind(k)).toBe(true);
    }
  });

  it("every hold value maps, through the function", () => {
    expect(Object.keys(WAIT_KIND_FROM.hold).sort()).toEqual(
      [...HOLD_ON].sort()
    );
    for (const on of HOLD_ON) {
      expect(waitKindOf({ kind: "hold", on })).toBe(WAIT_KIND_FROM.hold[on]);
    }
    // A hold on a person is their input (as its waiting-on reason says); a
    // party outside is a vendor; a park is nobody's.
    expect(waitKindOf({ kind: "hold", on: "person" })).toBe("answer");
    expect(waitKindOf({ kind: "hold", on: "external" })).toBe("vendor");
    expect(waitKindOf({ kind: "hold", on: "nobody" })).toBe("nobody");
    expect(waitKindOf({ kind: "hold", on: "unspecified" })).toBe("nobody");
  });

  it("a hold's dev ref outranks its on", () => {
    const on = "external" as const;
    expect(waitKindOf({ kind: "hold", on, devRef: "pr" })).toBe("ci");
    expect(waitKindOf({ kind: "hold", on, devRef: "main" })).toBe("red_main");
    expect(waitKindOf({ kind: "hold", on, devRef: "job" })).toBe("devbox_job");
    expect(waitKindOf({ kind: "hold", on, devRef: null })).toBe("vendor");
  });

  it("every source maps, a work unit by its checks", () => {
    const cases: Array<[WaitingOnSource, string]> = [
      [{ kind: "pending_proposal" }, "approval"],
      [{ kind: "blocked_by" }, "another_work"],
      [{ kind: "child_session" }, "another_work"],
      [{ kind: "work_unit", state: "open" }, "ci"],
      [{ kind: "work_unit", state: "open", checks: "failed" }, "ci"],
      [{ kind: "work_unit", state: "open", checks: "passed" }, "merge_queue"],
      [{ kind: "owed_slot" }, "answer"],
      [{ kind: "owed_slot", blockedReason: null }, "answer"],
      [{ kind: "owed_slot", blockedReason: "  Decision " }, "decide"],
      [{ kind: "owed_slot", blockedReason: "credential" }, "access"],
      [{ kind: "owed_slot", blockedReason: "physical" }, "answer"],
      [{ kind: "owed_slot", blockedReason: "something-new" }, "answer"],
    ];
    for (const [source, waitKind] of cases) {
      expect(waitKindOf(source)).toBe(waitKind);
    }
  });

  it("an owed slot is the person's move, whatever its blocked reason", () => {
    // An owed slot is `owner: 'human'`: even a physical act in the world is
    // theirs to do. Before, `physical` read as an outside party (`vendor`,
    // "With them") and Home dropped it from "Your move".
    for (const blockedReason of Object.keys(WAIT_KIND_FROM.blockedReason)) {
      const kind = waitKindOf({ kind: "owed_slot", blockedReason });
      expect(waitKindBall(kind), blockedReason).toBe("me");
    }
  });

  it("a step's declared waitKind wins; absent or unknown, its on decides", () => {
    for (const on of HOLD_ON) {
      expect(waitKindOf({ kind: "step", on })).toBe(WAIT_KIND_FROM.hold[on]);
      expect(waitKindOf({ kind: "step", on, waitKind: "signature" })).toBe(
        "signature"
      );
    }
    expect(waitKindOf({ kind: "step", on: "person" })).toBe("answer");
    expect(
      waitKindOf({ kind: "step", on: "person", waitKind: "their_reply" })
    ).toBe("their_reply");
    // A kind this build does not know (an older pod's typo) falls to `on`.
    expect(
      waitKindOf({
        kind: "step",
        on: "external",
        waitKind: "nope" as WaitKind,
      })
    ).toBe("vendor");
    const [mark] = deriveWaitingOn([
      {
        kind: "step",
        on: "person",
        waitKind: "their_reply",
        ref: { kind: "person", id: "p1", label: "Ada" },
      },
    ]);
    expect(mark).toEqual({
      reason: "input",
      count: 1,
      refs: [
        { kind: "person", id: "p1", label: "Ada", waitKind: "their_reply" },
      ],
    });
  });

  it("deriveWaitingOn stamps each named ref with its waitKind, never `kind`", () => {
    const marks = deriveWaitingOn([
      {
        kind: "work_unit",
        state: "open",
        checks: "passed",
        ref: { kind: "pull_request", url: "https://x/pull/1", label: "#1" },
      },
      {
        kind: "hold",
        on: "person",
        ref: { kind: "person", id: "p1", label: "Ada" },
      },
    ]);
    const refs = marks.flatMap((m) => m.refs ?? []);
    expect(refs.map((r) => [r.kind, r.waitKind])).toEqual([
      ["person", "answer"],
      ["pull_request", "merge_queue"],
    ]);
  });

  it("waitingOnRefView carries a known waitKind and drops an unknown one", () => {
    const ref = { kind: "person", id: "p1", label: "Ada" };
    expect(
      waitingOnRefView({ ...ref, waitKind: "signature" }, 0).waitKind
    ).toBe("signature");
    expect(waitingOnRefView({ ...ref, waitKind: "x" }, 0).waitKind).toBeNull();
    expect(waitingOnRefView(ref, 0).waitKind).toBeNull();
  });
});

describe("the axis is called waitKind", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return files(path);
      return name.endsWith(".ts") && !name.includes(".test.") ? [path] : [];
    });

  it("no field typed WaitKind is named anything but waitKind", () => {
    const offenders: string[] = [];
    for (const path of files(SRC)) {
      for (const m of readFileSync(path, "utf8").matchAll(
        /\b(\w+)\??\s*:\s*WaitKind\b/g
      )) {
        if (m[1] !== "waitKind")
          offenders.push(`${relative(SRC, path)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the two states a wait gives: With them, On a machine", () => {
  const base = { owedFromYou: 0, pendingDecisions: 0 };

  it("a ball outside reads with_them; a machine's reads on_machine", () => {
    expect(UNIT_STATES).toContain("with_them");
    expect(UNIT_STATES).toContain("on_machine");
    expect(resolveUnitState({ ...base, waitKind: "signature" })).toEqual({
      state: "with_them",
      tone: "info",
      glyph: "users",
      rail: { kind: "determinate", pct: 0 },
    });
    expect(resolveUnitState({ ...base, waitKind: "merge_queue" })).toEqual({
      state: "on_machine",
      tone: "textSecondary",
      glyph: "cpu",
      rail: { kind: "determinate", pct: 0 },
    });
    expect(resolveStatusLabel("with_them")).toBe("With them");
    expect(resolveStatusLabel("on_machine")).toBe("On a machine");
  });

  it("every them / machine kind reaches its state; no other ball does", () => {
    for (const k of WAIT_KINDS) {
      const state = resolveUnitState({ ...base, waitKind: k }).state;
      const ball = WAIT_KIND_BALL[k];
      if (ball === "them") expect(state).toBe("with_them");
      else if (ball === "machine") expect(state).toBe("on_machine");
      else expect(["with_them", "on_machine"]).not.toContain(state);
    }
  });

  it("your turn and an agent at work outrank a wait held elsewhere", () => {
    const w = { ...base, waitKind: "ci" as const };
    expect(resolveUnitState({ ...w, owedFromYou: 1 }).state).toBe("needs_you");
    expect(resolveUnitState({ ...w, pendingDecisions: 1 }).state).toBe(
      "needs_review"
    );
    expect(resolveUnitState({ ...w, agentAtWork: true }).state).toBe("working");
    expect(resolveUnitState({ ...w, failed: true }).state).toBe("failed");
    // A wait outranks a chain of work and a running guess.
    expect(
      resolveUnitState({ ...w, blockedBy: "X", running: true }).state
    ).toBe("on_machine");
  });
});
