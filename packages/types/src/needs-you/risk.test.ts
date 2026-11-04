/**
 * The ONE risk mark of a needs-you item, and the ask's swipe gate. Each case
 * names the wrong rule it rules out (`.claude/rules/guards-and-tests.md`).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Ask } from "../ask/index.js";
import { askIsSwipeSafe, askRiskView } from "../ask/card.js";
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

describe("askIsSwipeSafe — fails closed on every absence", () => {
  const confirm = (extra: Record<string, unknown> = {}): Ask =>
    ({ mode: "confirm", reversible: true, ...extra }) as unknown as Ask;
  const choose = (
    options: unknown[],
    extra: Record<string, unknown> = {}
  ): Ask =>
    ({ mode: "choose", options, reversible: true, ...extra }) as unknown as Ask;

  it("a routine, reversible, unmarked confirm swipes", () => {
    expect(askIsSwipeSafe(confirm())).toBe(true);
  });

  it("reversibility unsaid or false never swipes", () => {
    expect(askIsSwipeSafe(confirm({ reversible: undefined }))).toBe(false);
    expect(askIsSwipeSafe(confirm({ reversible: false }))).toBe(false);
  });

  it("a high or medium risk never swipes", () => {
    expect(askIsSwipeSafe(confirm({ risk: "high" }))).toBe(false);
    expect(askIsSwipeSafe(confirm({ risk: "medium" }))).toBe(false);
    expect(askIsSwipeSafe(confirm({ risk: "low" }))).toBe(true);
  });

  it("a commitment never swipes: declared, or forced by the pod", () => {
    expect(askIsSwipeSafe(confirm({ stakes: "commitment" }))).toBe(false);
    expect(askIsSwipeSafe(confirm(), { forced: true })).toBe(false);
  });

  it("act, provide and form never swipe, whatever their risk", () => {
    for (const mode of ["act", "provide", "form"])
      expect(
        askIsSwipeSafe({
          mode,
          reversible: true,
          provide: { kind: "file" },
          form: { fields: [] },
        } as unknown as Ask)
      ).toBe(false);
  });

  it("a choose swipes only to its ONE recommended option, with no follow-up", () => {
    expect(
      askIsSwipeSafe(
        choose([{ label: "A", recommended: true }, { label: "B" }])
      )
    ).toBe(true);
    expect(askIsSwipeSafe(choose([{ label: "A" }, { label: "B" }]))).toBe(
      false
    );
    expect(
      askIsSwipeSafe(
        choose([
          {
            label: "A",
            recommended: true,
            followUp: {
              prompt: "Which?",
              options: [{ label: "x" }, { label: "y" }],
            },
          },
        ])
      )
    ).toBe(false);
  });

  it("no ask never swipes", () => {
    expect(askIsSwipeSafe(null)).toBe(false);
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
