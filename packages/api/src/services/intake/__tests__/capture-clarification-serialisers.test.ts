/**
 * The pod's context serialisers are MIRRORS of `@synap-core/capture-pipeline`
 * (synap-backend cannot depend on a synap-app source package). A client refine
 * and a pod re-run must hand the structurer the SAME context string.
 *
 * Two layers:
 *  1. PINNED outputs — always run; this is what the pod guarantees.
 *  2. SAMENESS against the client source, when the monorepo checkout has it
 *     (`followup.ts` for `chipToContext`, `clarification.ts` for
 *     `formValuesToContext` + `answerContextWithQuestion`). A missing file is a
 *     visible skip, never a silent pass.
 *
 * Every `.map` uses an explicit lambda: `.map(fn)` passes the array INDEX as
 * the second argument, which would silently feed a "question" of `1`.
 *
 * Rows are chosen where candidate rules DISAGREE: a description with no
 * question, a question with no description, a whitespace-only question (trim
 * vs not), an empty body (prefixed vs special-cased), and an undefined question.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { REDACTED_SECRET } from "@synap-core/types/capture";
import {
  answerContextWithQuestion,
  answerToContext,
  chipToContext,
  formValuesToContext,
} from "../capture-clarification.js";

const PIPELINE_SRC = resolve(
  __dirname,
  "../../../../../../../synap-app/packages/core/capture-pipeline/src"
);

const CHIPS = [
  {
    label: "Alice Martin",
    value: "am",
    action: "link_entity" as const,
    entityId: "e-1",
  },
  {
    label: "Due Friday",
    value: "fri",
    action: "set_property" as const,
    propertyKey: "dueDate",
  },
  {
    label: "Both",
    value: "b",
    action: "add_relation" as const,
    entityId: "e-2",
    propertyKey: "k",
  },
  { label: "Someone new", value: "new", action: "confirm" as const },
  // Description present (no question involved): suffix only.
  {
    label: "Alice",
    value: "a",
    action: "link_entity" as const,
    entityId: "e-1",
    description: "Links to Alice at Acme",
  },
  // Empty description: byte-identical to no description.
  { label: "Plain", value: "p", action: "confirm" as const, description: "" },
  // Whitespace-only description is NOT trimmed (the question is; the
  // description is not) — the row that tells the two rules apart.
  {
    label: "Acme Corp",
    value: "acme",
    action: "link_entity" as const,
    description: "  ",
  },
];

const FORMS: Array<Record<string, unknown>> = [
  { dueDate: "2026-09-20", empty: "", nothing: null, missing: undefined },
  { tags: ["q3", "sales"], owner: { id: "u1" }, count: 0, done: false },
  {},
  // A typed key must never reach the model's context.
  { name: "Acme", apiKey: { kind: "new", value: "sk-live-abc123" } },
  // An `existing` ref is a pointer, not a credential — passes through. This row
  // separates "redact any object" from "redact only a NEW secret".
  { apiKey: { kind: "existing", ref: "vault://abc" } },
  // `kind:"new"` with a non-string value is not the secret shape (the predicate
  // requires a string) — passes through, exactly as the client mirror does.
  { odd: { kind: "new", value: 5 } },
];

const QUESTION_ROWS: Array<[string | undefined | null, string]> = [
  [undefined, "Answer: X (confirm)"],
  [null, "b"],
  ["   ", "b"],
  [
    "Which Alice?",
    "Answer: Alice (link_entity, entityId=e-1) — Links to Alice at Acme",
  ],
  ["Q?", ""],
  ["  Padded?  ", "body"],
  // L2's client-side pins, mirrored.
  [" Which? ", "b"],
  ["", "Answer: X (confirm)"],
  ["\n", "Answer: X (confirm)"],
];

describe("pinned outputs", () => {
  it("chipToContext (description suffix only when non-empty)", () => {
    expect(CHIPS.map((c) => chipToContext(c))).toEqual([
      "Answer: Alice Martin (link_entity, entityId=e-1)",
      "Answer: Due Friday (set_property, propertyKey=dueDate)",
      "Answer: Both (add_relation, entityId=e-2, propertyKey=k)",
      "Answer: Someone new (confirm)",
      "Answer: Alice (link_entity, entityId=e-1) — Links to Alice at Acme",
      "Answer: Plain (confirm)",
      "Answer: Acme Corp (link_entity) —   ",
    ]);
  });

  it("formValuesToContext drops empty values and JSON-encodes objects", () => {
    expect(FORMS.map((f) => formValuesToContext(f))).toEqual([
      "dueDate: 2026-09-20",
      'tags: ["q3","sales"]; owner: {"id":"u1"}; count: 0; done: false',
      "",
      'name: Acme; apiKey: {"kind":"new","value":"[redacted]"}',
      'apiKey: {"kind":"existing","ref":"vault://abc"}',
      'odd: {"kind":"new","value":5}',
    ]);
  });

  it("formValuesToContext never carries a typed secret (and the redaction constant matches the client)", () => {
    const out = FORMS.map((f) => formValuesToContext(f)).join("\n");
    expect(out).not.toContain("sk-live-abc123");
    expect(REDACTED_SECRET).toBe("[redacted]");
  });

  it("answerContextWithQuestion prefixes only a non-blank question, verbatim", () => {
    expect(
      QUESTION_ROWS.map(([q, b]) => answerContextWithQuestion(q, b))
    ).toEqual([
      "Answer: X (confirm)",
      "b",
      "b",
      "Question: Which Alice?\nAnswer: Alice (link_entity, entityId=e-1) — Links to Alice at Acme",
      "Question: Q?\n",
      "Question:   Padded?  \nbody",
      "Question:  Which? \nb",
      "Answer: X (confirm)",
      "Answer: X (confirm)",
    ]);
  });

  it("answerToContext prefixes chip / text / form alike, never skip", () => {
    const q = "Which Alice?";
    expect(answerToContext({ type: "chip", chip: CHIPS[4]! }, q)).toBe(
      "Question: Which Alice?\nAnswer: Alice (link_entity, entityId=e-1) — Links to Alice at Acme"
    );
    expect(
      answerToContext({ type: "text", text: "The one from Acme" }, q)
    ).toBe("Question: Which Alice?\nThe one from Acme");
    expect(
      answerToContext({ type: "form", values: { company: "Acme" } }, q)
    ).toBe("Question: Which Alice?\ncompany: Acme");
    expect(answerToContext({ type: "skip" }, q)).toBeNull();
    // No question in scope → the body alone, byte-identical to before.
    expect(answerToContext({ type: "text", text: "Acme" })).toBe("Acme");
  });
});

describe("sameness with @synap-core/capture-pipeline", () => {
  const followup = resolve(PIPELINE_SRC, "followup.ts");
  const clarification = resolve(PIPELINE_SRC, "clarification.ts");

  it.skipIf(!existsSync(followup))(
    "chipToContext matches followup.ts",
    async () => {
      const client = (await import(followup)) as {
        chipToContext: typeof chipToContext;
      };
      expect(CHIPS.map((c) => client.chipToContext(c))).toEqual(
        CHIPS.map((c) => chipToContext(c))
      );
    }
  );

  it.skipIf(!existsSync(clarification))(
    "formValuesToContext matches clarification.ts (L2)",
    async () => {
      const client = (await import(clarification)) as {
        formValuesToContext?: typeof formValuesToContext;
      };
      expect(typeof client.formValuesToContext).toBe("function");
      expect(FORMS.map((f) => client.formValuesToContext!(f))).toEqual(
        FORMS.map((f) => formValuesToContext(f))
      );
    }
  );

  it.skipIf(!existsSync(clarification))(
    "answerContextWithQuestion matches clarification.ts (L2, lane LB)",
    async () => {
      const client = (await import(clarification)) as {
        answerContextWithQuestion?: typeof answerContextWithQuestion;
      };
      expect(
        typeof client.answerContextWithQuestion,
        "L2 has not landed answerContextWithQuestion yet"
      ).toBe("function");
      expect(
        QUESTION_ROWS.map(([q, b]) => client.answerContextWithQuestion!(q, b))
      ).toEqual(QUESTION_ROWS.map(([q, b]) => answerContextWithQuestion(q, b)));
    }
  );
});
