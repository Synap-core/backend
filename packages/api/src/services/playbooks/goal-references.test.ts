/**
 * The backend half of the goal ⇄ params check. `findUnresolvedReferences` is
 * already pinned by `command-template.test.ts`; what is NOT covered anywhere is
 * the adapter that reads declared names off the loose `playbooks.params` JSONB —
 * which is exactly where a wrong field name would silently report "nothing
 * unresolved" for every playbook and make the whole door a no-op.
 */
import { describe, expect, it } from "vitest";
import {
  describeGoalPlaceholderProblems,
  findGoalPlaceholderProblems,
  findUnresolvedGoalReferences,
} from "./goal-references.js";

describe("findUnresolvedGoalReferences", () => {
  it("a goal fully backed by declared params is clean", () => {
    expect(
      findUnresolvedGoalReferences("Compare {ourSpace} against {competitor}", [
        { name: "ourSpace", type: "text" },
        { name: "competitor", type: "text" },
      ])
    ).toEqual([]);
  });

  it("flags a placeholder no declared param backs", () => {
    expect(
      findUnresolvedGoalReferences("Compare {ourSpace} against {competitor}", [
        { name: "ourSpace", type: "text" },
      ])
    ).toEqual([{ text: "{competitor}", kind: "unknown-arg" }]);
  });

  it("reads the `name` field — a params array of other shapes declares nothing", () => {
    // The guard against the adapter silently matching on the wrong key: if this
    // returned [] the door would pass everything.
    expect(
      findUnresolvedGoalReferences("Check {competitor}", [
        { label: "competitor", type: "text" },
      ])
    ).toEqual([{ text: "{competitor}", kind: "unknown-arg" }]);
  });

  it("tolerates missing / non-array params and a missing goal", () => {
    expect(findUnresolvedGoalReferences("Check {competitor}", null)).toEqual([
      { text: "{competitor}", kind: "unknown-arg" },
    ]);
    expect(findUnresolvedGoalReferences(null, [])).toEqual([]);
    expect(findUnresolvedGoalReferences("", [])).toEqual([]);
  });

  it("leaves grammar-#3 {{path}} bindings alone (a different resolver owns them)", () => {
    expect(
      findUnresolvedGoalReferences("Use {{trigger.payload.prompt}}", [])
    ).toEqual([]);
  });

  it("reports braced text no rule matches as unsupported", () => {
    expect(findUnresolvedGoalReferences("see {the notes}", [])).toEqual([
      { text: "{the notes}", kind: "unsupported" },
    ]);
  });
});

describe("findGoalPlaceholderProblems — what the doors refuse", () => {
  it("a bare {{name}} is a problem whether or not it is declared", () => {
    expect(findGoalPlaceholderProblems('Run "{{task}}"', [])).toEqual([
      { text: "{{task}}", name: "task", kind: "double-brace", declared: false },
    ]);
    expect(
      findGoalPlaceholderProblems('Run "{{ task }}"', [{ name: "task" }])
    ).toEqual([
      {
        text: "{{ task }}",
        name: "task",
        kind: "double-brace",
        declared: true,
      },
    ]);
  });

  it("an undeclared {name} / @{arg:name} is a problem; a declared one is not", () => {
    expect(
      findGoalPlaceholderProblems("Enrich {target} via @{arg:source:text}", [
        { name: "target", type: "text" },
      ])
    ).toEqual([
      {
        text: "@{arg:source:text}",
        name: "source",
        kind: "undeclared",
        declared: false,
      },
    ]);
  });

  it("rooted automation paths and braced prose are NOT placeholders", () => {
    expect(
      findGoalPlaceholderProblems(
        "Use {{trigger.payload.prompt}} and {{steps.a.output}}; see {the notes}",
        []
      )
    ).toEqual([]);
  });

  it("declared means what the RUN door reads (readPlaybookParams: trimmed names)", () => {
    expect(findGoalPlaceholderProblems("Do {x}", [{ name: " x " }])).toEqual(
      []
    );
  });

  it("orders as written, each text once", () => {
    expect(
      findGoalPlaceholderProblems("{b} then {{a}} then {b} then {{a}}", []).map(
        (p) => p.text
      )
    ).toEqual(["{b}", "{{a}}"]);
  });
});

describe("describeGoalPlaceholderProblems — the refusal names the fix", () => {
  it("says what to declare and how to respell", () => {
    const msg = describeGoalPlaceholderProblems(
      findGoalPlaceholderProblems("Qualify {{lead}} ({segment})", [])
    );
    expect(msg).toContain('"lead", "segment"');
    expect(msg).toContain(
      '{ "name": "lead", "type": "text", "required": true }'
    );
    expect(msg).toContain("{{lead}} → {lead}");
  });
});
