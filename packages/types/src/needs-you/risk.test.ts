/**
 * The ONE risk mark of a needs-you item, and the ask's swipe gate. Each case
 * names the wrong rule it rules out (`.claude/rules/guards-and-tests.md`).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ask } from "../ask/index.js";
import { askIsSwipeSafe, askRiskView, askSwipeAnswer } from "../ask/card.js";
import { IRREVERSIBLE_MARK_LABEL } from "../proposals/intent.js";
import { isUnitTone } from "../units/state.js";
import {
  NEEDS_YOU_RISK_LEVELS,
  NEEDS_YOU_RISK_LABELS,
  needsYouRisk,
  type NeedsYouRiskItem,
  type NeedsYouRiskLevel,
} from "./risk.js";

describe("needsYouRisk — one mark for asks and requests", () => {
  const CASES: Array<{
    item: NeedsYouRiskItem;
    level: NeedsYouRiskLevel | null;
    rulesOut: string;
  }> = [
    {
      item: { kind: "ask", ask: { risk: "high" } },
      level: "high",
      rulesOut: "a high-risk ask drawn quieter than a medium one",
    },
    {
      item: { kind: "ask", ask: { risk: "high", reversible: false } },
      level: "high",
      rulesOut: "the lock outranking a declared high risk (losing the alarm)",
    },
    {
      item: { kind: "ask", ask: { risk: "medium", reversible: false } },
      level: "irreversible",
      rulesOut: "a medium judgement hiding that the act can't be undone",
    },
    {
      item: { kind: "ask", ask: { risk: "medium" } },
      level: "medium",
      rulesOut: "medium drawing nothing",
    },
    {
      item: { kind: "ask", ask: { risk: "low", reversible: true } },
      level: null,
      rulesOut: "low risk drawing a mark",
    },
    {
      item: { kind: "ask", ask: {} },
      level: null,
      rulesOut:
        "an ask that says nothing read as irreversible (unsaid is not false)",
    },
    {
      item: { kind: "ask", ask: null },
      level: null,
      rulesOut: "an absent ask throwing",
    },
    {
      item: { kind: "proposal", revertable: false },
      level: "irreversible",
      rulesOut: "a request that cannot be reverted drawing nothing",
    },
    {
      item: { kind: "proposal", revertable: null },
      level: "irreversible",
      rulesOut: "an UNMEASURED request promising an undo nobody checked",
    },
    {
      item: { kind: "proposal" },
      level: "irreversible",
      rulesOut: "an absent revertability read as revertable",
    },
    {
      item: { kind: "proposal", revertable: true },
      level: null,
      rulesOut: "a revertable request carrying the lock",
    },
  ];
  for (const c of CASES) {
    it(`${JSON.stringify(c.item)} → ${c.level} (rules out: ${c.rulesOut})`, () => {
      expect(needsYouRisk(c.item)?.level ?? null).toBe(c.level);
    });
  }

  it("every mark wears a real UnitTone (never `danger`) and its one label", () => {
    for (const level of NEEDS_YOU_RISK_LEVELS) {
      const item: NeedsYouRiskItem =
        level === "irreversible"
          ? { kind: "proposal", revertable: false }
          : { kind: "ask", ask: { risk: level } };
      const mark = needsYouRisk(item)!;
      expect(isUnitTone(mark.tone)).toBe(true);
      expect(mark.label).toBe(NEEDS_YOU_RISK_LABELS[level]);
    }
    expect(NEEDS_YOU_RISK_LABELS.irreversible).toBe(IRREVERSIBLE_MARK_LABEL);
  });

  it("an irreversible ask and an irreversible request wear the SAME mark", () => {
    expect(needsYouRisk({ kind: "ask", ask: { reversible: false } })).toEqual(
      needsYouRisk({ kind: "proposal", revertable: false })
    );
  });

  it("askRiskView is the ask arm of needsYouRisk, not a second derivation", () => {
    for (const ask of [
      { risk: "high" as const },
      { risk: "medium" as const },
      { risk: "low" as const },
      { reversible: false },
      {},
    ])
      expect(askRiskView(ask)).toEqual(needsYouRisk({ kind: "ask", ask }));
  });
});

describe("askSwipeAnswer — fails closed on every absence", () => {
  const YES = { recommended: true };
  const confirm = (extra: Record<string, unknown> = {}): Ask =>
    ({
      mode: "confirm",
      yes: YES,
      reversible: true,
      ...extra,
    }) as unknown as Ask;
  const choose = (
    options: unknown[],
    extra: Record<string, unknown> = {}
  ): Ask =>
    ({ mode: "choose", options, reversible: true, ...extra }) as unknown as Ask;
  /** The pod stamped it: not forced. */
  const swipe = (ask: Ask | null) => askSwipeAnswer({ ask, forced: false });

  it("a routine, reversible, unmarked confirm swipes to its recommended yes", () => {
    expect(swipe(confirm())).toEqual({ type: "confirm", confirmed: true });
    expect(askIsSwipeSafe({ ask: confirm(), forced: false })).toBe(true);
  });

  it("the swipe gives the RECOMMENDED answer: a recommended no swipes to no", () => {
    expect(
      swipe(confirm({ yes: undefined, no: { recommended: true } }))
    ).toEqual({ type: "confirm", confirmed: false });
  });

  it("a confirm with no recommendation never swipes (no guessed yes or no)", () => {
    expect(swipe(confirm({ yes: undefined }))).toBeNull();
  });

  it("a missing pod stamp never swipes: forced absent, null or true", () => {
    expect(askSwipeAnswer({ ask: confirm(), forced: undefined })).toBeNull();
    expect(askSwipeAnswer({ ask: confirm(), forced: null })).toBeNull();
    expect(askSwipeAnswer({ ask: confirm(), forced: true })).toBeNull();
  });

  it("reversibility unsaid or false never swipes", () => {
    expect(swipe(confirm({ reversible: undefined }))).toBeNull();
    expect(swipe(confirm({ reversible: false }))).toBeNull();
  });

  it("a high or medium risk never swipes", () => {
    expect(swipe(confirm({ risk: "high" }))).toBeNull();
    expect(swipe(confirm({ risk: "medium" }))).toBeNull();
    expect(swipe(confirm({ risk: "low" }))).not.toBeNull();
  });

  it("a declared commitment never swipes, even stamped not forced", () => {
    expect(swipe(confirm({ stakes: "commitment" }))).toBeNull();
  });

  it("act, provide and form never swipe, whatever their risk", () => {
    for (const mode of ["act", "provide", "form"])
      expect(
        swipe({
          mode,
          reversible: true,
          provide: { kind: "file" },
          form: { fields: [] },
        } as unknown as Ask)
      ).toBeNull();
  });

  it("a choose swipes only to its ONE recommended option, with no follow-up", () => {
    const a = { label: "A", recommended: true };
    expect(swipe(choose([a, { label: "B" }]))).toEqual({
      type: "chip",
      chip: a,
    });
    expect(swipe(choose([{ label: "A" }, { label: "B" }]))).toBeNull();
    expect(
      swipe(
        choose([
          {
            ...a,
            followUp: {
              prompt: "Which?",
              options: [{ label: "x" }, { label: "y" }],
            },
          },
        ])
      )
    ).toBeNull();
  });

  it("no ask never swipes", () => {
    expect(swipe(null)).toBeNull();
  });
});

describe("tripwire: the risk words have ONE home", () => {
  // Derived, not hand-listed: every non-test source file of this package.
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !/\.test\.ts$|\.d\.ts$/.test(p))
        files.push(p);
    }
  };
  walk(SRC);

  it("scans the package (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("needs-you/risk.ts"))).toBe(true);
  });

  const HOMES: Record<string, string> = {
    '"High risk"': "needs-you/risk.ts",
    '"Medium risk"': "needs-you/risk.ts",
    '"Can\'t be undone"': "proposals/intent.ts",
  };
  for (const [literal, home] of Object.entries(HOMES)) {
    it(`${literal} is written only in ${home}`, () => {
      const at = files
        .filter((f) => readFileSync(f, "utf8").includes(literal))
        .map((f) => relative(SRC, f));
      expect(at).toEqual([home]);
    });
  }
});
