/**
 * The Home brief. Each case names the WRONG rule it rules out — a row two
 * candidate rules agree on is decoration (guards-and-tests.md).
 */
import { describe, expect, it } from "vitest";
import {
  HOME_BRIEF_ALL_CLEAR,
  homeBrief,
  homeBriefText,
  type HomeBriefInput,
} from "./home-brief.js";

const ZERO = { count: 0 };
const QUIET: HomeBriefInput = {
  since: "last-seen",
  produced: ZERO,
  decisions: ZERO,
  questions: ZERO,
  projectsHeldUp: ZERO,
  failed: ZERO,
  working: ZERO,
};
const brief = (over: Partial<HomeBriefInput>) => homeBrief({ ...QUIET, ...over });
const text = (over: Partial<HomeBriefInput>) => homeBriefText(brief(over));

describe("homeBrief — one sentence, every noun a door", () => {
  it("the board's sentence, clause by clause", () => {
    const b = brief({
      produced: { count: 8 },
      decisions: { count: 3 },
      projectsHeldUp: { count: 2 },
      failed: { count: 1 },
    });
    expect(homeBriefText(b)).toBe(
      "While you were away your agents finished 8 things. 3 decisions are holding up 2 projects. 1 run failed."
    );
    // Every number is a door, and each to its own place.
    const doors = b.clauses.flatMap((c) =>
      c.segments.filter((s) => s.door).map((s) => [s.text, s.door])
    );
    expect(doors).toEqual([
      ["finished 8 things", { kind: "produced" }],
      ["3 decisions", { kind: "inbox", bucket: "decision" }],
      ["2 projects", { kind: "projects" }],
      ["1 run failed", { kind: "inbox", bucket: "broken" }],
    ]);
  });

  it("produced: a zero clause is dropped, never '0 things' (rules out: print every count)", () => {
    expect(text({ produced: ZERO, failed: { count: 2 } })).toBe("2 runs failed.");
  });

  it("produced: with no last visit the window is today (rules out: 'while you were away' on a first open)", () => {
    expect(text({ since: "today", produced: { count: 1 } })).toBe("Today your agents finished 1 thing.");
  });

  it("waiting: one decision is singular; decisions and questions join (rules out: always plural)", () => {
    expect(text({ decisions: { count: 1 }, projectsHeldUp: { count: 1 } })).toBe(
      "1 decision is holding up 1 project."
    );
    expect(text({ decisions: { count: 2 }, questions: { count: 1 } })).toBe(
      "2 decisions and 1 question wait on you."
    );
    const doors = brief({ decisions: { count: 2 }, questions: { count: 1 } }).clauses[0]!.segments
      .filter((s) => s.door)
      .map((s) => s.door);
    expect(doors).toEqual([
      { kind: "inbox", bucket: "decision" },
      { kind: "inbox", bucket: "question" },
    ]);
  });

  it("waiting: an UNKNOWN project count never invents a link (rules out: 'holding up – projects')", () => {
    expect(text({ questions: { count: 1 }, projectsHeldUp: { count: null } })).toBe("1 question waits on you.");
  });

  it("a capped count reads N+ and is plural (rules out: a bare capped number)", () => {
    expect(text({ decisions: { count: 100, floor: true }, projectsHeldUp: { count: 4 } })).toBe(
      "100+ decisions are holding up 4 projects."
    );
    expect(text({ decisions: { count: 1, floor: true } })).toBe("1+ decisions wait on you.");
  });

  it("working: agents on it now open the moving list", () => {
    const b = brief({ working: { count: 2 } });
    expect(homeBriefText(b)).toBe("2 agents are working now.");
    expect(b.clauses[0]!.segments[0]!.door).toEqual({ kind: "moving" });
    expect(text({ working: { count: 1 } })).toBe("1 agent is working now.");
  });

  it("all known and zero is REASSURE (rules out: an empty sentence)", () => {
    const b = brief({});
    expect(b.answer).toBe("reassure");
    expect(homeBriefText(b)).toBe(HOME_BRIEF_ALL_CLEAR);
  });

  it("an unread count is never calm: zero clauses + one unknown is 'unknown', not REASSURE", () => {
    const b = brief({ failed: { count: null } });
    expect(b.answer).toBe("unknown");
    expect(b.unknown).toBe(true);
    expect(b.reassure).toBeNull();
    // With something to say it is a brief, still flagged partial.
    const partial = brief({ produced: { count: 3 }, decisions: { count: null } });
    expect(partial.answer).toBe("brief");
    expect(partial.unknown).toBe(true);
  });

  it("the project count alone neither makes it partial nor blocks the all-clear", () => {
    expect(brief({ projectsHeldUp: { count: null } }).answer).toBe("reassure");
  });
});
