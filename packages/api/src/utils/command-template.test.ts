/**
 * Grammar #1 — substitution, the bare `{name}` legacy-compat rule, and the
 * miss policy.
 *
 * The bug these pin: every playbook goal in the live pod writes `{competitor}`
 * / `{focus}`, which no rule in the grammar matched, so the literal placeholder
 * was handed to the model — and every unresolved reference resolved to `""`
 * with no record that anything had gone missing.
 *
 * The hard constraint on the fix is that it be ADDITIVE: no template that
 * worked before may change meaning. Most of what is below is therefore
 * regression cover for the forms that already worked.
 */

import { describe, expect, it } from "vitest";
import {
  parseCommandTemplate,
  findUnresolvedReferences,
  validateArgumentValues,
} from "./command-template.js";

describe("substitute — canonical forms still win (regression)", () => {
  it("substitutes @{arg:NAME}", () => {
    const t = parseCommandTemplate("Analyse @{arg:competitor} now");
    expect(t.substitute({ competitor: "Acme" })).toBe("Analyse Acme now");
  });

  it("substitutes @{arg:NAME:type} and typed/choice args", () => {
    const t = parseCommandTemplate(
      "@{arg:n:number} on @{arg:mode:choice=fast,slow}"
    );
    expect(t.substitute({ n: "3", mode: "fast" })).toBe("3 on fast");
    expect(t.derivedInputs).toEqual([
      { name: "n", label: "n", type: "number", options: null, default: null },
      {
        name: "mode",
        label: "mode",
        type: "choice",
        options: ["fast", "slow"],
        default: null,
      },
    ]);
  });

  it('still substitutes the legacy {argument name="x"} form', () => {
    const t = parseCommandTemplate('Hi {argument name="who"}!');
    expect(t.substitute({ who: "Ada" })).toBe("Hi Ada!");
  });

  it("still substitutes legacy {selection}", () => {
    const t = parseCommandTemplate("Summarise {selection}");
    expect(
      t.substitute({}, { type: "text", text: "the quick brown fox" })
    ).toBe("Summarise the quick brown fox");
  });

  it("canonical @{arg:x} wins over a bare {x} of the same name", () => {
    // Both forms present: each is replaced by its own rule, canonical first.
    const t = parseCommandTemplate("@{arg:x} and {x}");
    expect(t.substitute({ x: "V" })).toBe("V and V");
  });

  it("an unsupplied @{arg:NAME} is still the empty string, not a throw", () => {
    const t = parseCommandTemplate("A@{arg:missing}B");
    expect(t.substitute({})).toBe("AB");
  });

  it("resolves @{entity:ID:NAME}, falling back to the author-time label", () => {
    const t = parseCommandTemplate("See @{entity:e1:Old Label}");
    expect(t.substitute({}, null, { e1: "Acme Corp (company)" })).toBe(
      "See Acme Corp (company)"
    );
    expect(t.substitute({})).toBe("See Old Label");
  });
});

describe("substitute — bare {name}, resolved ONLY against declared params", () => {
  it("substitutes a bare {name} that IS a declared argument", () => {
    const t = parseCommandTemplate("Compare {ourSpace} against {competitor}");
    expect(t.substitute({ ourSpace: "Synap", competitor: "Notion" })).toBe(
      "Compare Synap against Notion"
    );
  });

  it("leaves a bare {name} that is NOT declared exactly as written", () => {
    const t = parseCommandTemplate("Compare {ourSpace} against {competitor}");
    expect(t.substitute({ ourSpace: "Synap" })).toBe(
      "Compare Synap against {competitor}"
    );
  });

  it("never eats a grammar-#3 {{path}} — even a single-identifier one", () => {
    const t = parseCommandTemplate(
      "{{focus}} and {{trigger.payload.prompt}} and {{ spaced }}"
    );
    // `focus` is declared and would substitute in BARE form; it must not here.
    expect(t.substitute({ focus: "LEAK", prompt: "LEAK" })).toBe(
      "{{focus}} and {{trigger.payload.prompt}} and {{ spaced }}"
    );
  });

  it("leaves prose, JSON and dotted paths in braces untouched", () => {
    const t = parseCommandTemplate(
      'Emit {"kind": 1} for {a.b} — see {the notes below}'
    );
    expect(t.substitute({ kind: "X", a: "X", b: "X" })).toBe(
      'Emit {"kind": 1} for {a.b} — see {the notes below}'
    );
  });

  it("does not resolve inherited Object.prototype keys", () => {
    const t = parseCommandTemplate("{constructor}/{toString}");
    expect(t.substitute({})).toBe("{constructor}/{toString}");
  });

  it("leaves a bare name adjacent to a closing brace alone", () => {
    // `{x}}` is ambiguous with grammar #3; the conservative read is "not ours".
    const t = parseCommandTemplate("{x}}");
    expect(t.substitute({ x: "V" })).toBe("{x}}");
  });

  it("does not mint derived inputs from bare names", () => {
    // derived_inputs is persisted and gates validateArgumentValues — minting
    // from prose braces would start REJECTING runs that work today.
    const t = parseCommandTemplate("Compare {ourSpace} to {competitor}");
    expect(t.derivedInputs).toEqual([]);
    expect(validateArgumentValues(t.derivedInputs, {})).toBeNull();
  });
});

describe("miss policy — a miss keeps its value but stops being silent", () => {
  it('records an unknown @{arg:NAME} while still substituting ""', () => {
    const t = parseCommandTemplate("A@{arg:gone}B");
    const { text, misses } = t.substituteWithMisses({});
    expect(text).toBe("AB");
    expect(misses).toEqual([{ name: "gone", kind: "unknown-arg", count: 1 }]);
  });

  it("records an undeclared bare {name} as a literal-brace miss", () => {
    const t = parseCommandTemplate("Compare {ourSpace} to {competitor}");
    const { text, misses } = t.substituteWithMisses({ ourSpace: "Synap" });
    expect(text).toBe("Compare Synap to {competitor}");
    expect(misses).toEqual([
      { name: "competitor", kind: "literal-brace", count: 1 },
    ]);
  });

  it("records unresolved context and stale static entities", () => {
    const t = parseCommandTemplate("@{context:url} @{entity:e9:Old Label}");
    const { text, misses } = t.substituteWithMisses({});
    expect(text).toBe(" Old Label");
    expect(misses).toEqual([
      { name: "context:url", kind: "unresolved-context", count: 1 },
      { name: "e9", kind: "unresolved-entity", count: 1 },
    ]);
  });

  it("counts repeats rather than duplicating the miss", () => {
    const t = parseCommandTemplate("@{arg:gone} @{arg:gone} @{arg:gone}");
    expect(t.substituteWithMisses({}).misses).toEqual([
      { name: "gone", kind: "unknown-arg", count: 3 },
    ]);
  });

  it("records nothing when everything resolves", () => {
    const t = parseCommandTemplate("@{arg:a} {b}");
    expect(t.substituteWithMisses({ a: "1", b: "2" })).toEqual({
      text: "1 2",
      misses: [],
    });
  });

  it("plain substitute() is unaffected by diagnostics", () => {
    const t = parseCommandTemplate("A@{arg:gone}B {nope}");
    expect(t.substitute({})).toBe("AB {nope}");
  });
});

describe("findUnresolvedReferences — the author-time half of the same truth", () => {
  it("flags bare names that are not declared, and clears the ones that are", () => {
    const goal = "Compare {ourSpace} against {competitor}";
    expect(findUnresolvedReferences(goal, ["ourSpace", "competitor"])).toEqual(
      []
    );
    expect(findUnresolvedReferences(goal, ["ourSpace"])).toEqual([
      { text: "{competitor}", kind: "unknown-arg" },
    ]);
  });

  it("flags an undeclared canonical @{arg:NAME}", () => {
    expect(findUnresolvedReferences("@{arg:gone:number}", ["kept"])).toEqual([
      { text: "@{arg:gone:number}", kind: "unknown-arg" },
    ]);
  });

  it('flags an undeclared legacy {argument name="x"}', () => {
    expect(findUnresolvedReferences('{argument name="who"}', [])).toEqual([
      { text: '{argument name="who"}', kind: "unknown-arg" },
    ]);
  });

  it("never flags context, selection or static-entity refs", () => {
    expect(
      findUnresolvedReferences(
        '@{context:url} @{context:entity} {selection} {selection type="entities"} @{entity:e1:Acme}',
        []
      )
    ).toEqual([]);
  });

  it("ignores grammar #3 {{path}} entirely", () => {
    expect(
      findUnresolvedReferences("{{trigger.payload.x}} {{focus}}", [])
    ).toEqual([]);
  });

  it("reports braced text that matches no rule as unsupported", () => {
    expect(findUnresolvedReferences("see {the notes} and {a.b}", [])).toEqual([
      { text: "{the notes}", kind: "unsupported" },
      { text: "{a.b}", kind: "unsupported" },
    ]);
  });

  // Order is stable but is PASS order (canonical → legacy → bare → unsupported),
  // then document position within a pass — not raw document order.
  it("deduplicates repeats, stable within a pass", () => {
    expect(findUnresolvedReferences("{a} {b} {a} {the x}", [])).toEqual([
      { text: "{a}", kind: "unknown-arg" },
      { text: "{b}", kind: "unknown-arg" },
      { text: "{the x}", kind: "unsupported" },
    ]);
  });

  it("agrees with substitute(): what it flags is what stays literal or empties", () => {
    // The two halves must not disagree — that divergence is the whole bug.
    const goal = "Do {declared}, then {undeclared}, using @{arg:alsoGone}";
    const declared = ["declared"];
    const flagged = findUnresolvedReferences(goal, declared).map((r) => r.text);
    expect(flagged).toEqual(["@{arg:alsoGone}", "{undeclared}"]);
    expect(parseCommandTemplate(goal).substitute({ declared: "A" })).toBe(
      "Do A, then {undeclared}, using "
    );
  });
});
