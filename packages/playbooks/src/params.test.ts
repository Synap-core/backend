import { describe, it, expect } from "vitest";
import {
  readPlaybookParams,
  validatePlaybookParams,
  describeMissingParams,
} from "./params.js";
import type { PlaybookParam } from "./index.js";

const p = (over: Partial<PlaybookParam> & { name: string }): PlaybookParam => ({
  type: "text",
  ...over,
});

describe("readPlaybookParams", () => {
  it("reads a well-formed bag", () => {
    expect(
      readPlaybookParams([
        { name: "who", type: "entity", required: true, label: " Who " },
        { name: "tone", type: "choice", options: ["warm", "blunt"] },
      ])
    ).toEqual([
      { name: "who", type: "entity", required: true, label: "Who" },
      { name: "tone", type: "choice", options: ["warm", "blunt"] },
    ]);
  });

  it("drops nameless, duplicate and non-object entries; never throws", () => {
    expect(
      readPlaybookParams([
        null,
        "nope",
        { type: "text" },
        { name: "  " },
        { name: "a", type: "number" },
        { name: "a", type: "text" },
      ])
    ).toEqual([{ name: "a", type: "number" }]);
  });

  it("reads an unknown or missing type as text — a legacy declaration stays enforced", () => {
    expect(
      readPlaybookParams([{ name: "a" }, { name: "b", type: "wat" }])
    ).toEqual([
      { name: "a", type: "text" },
      { name: "b", type: "text" },
    ]);
  });

  it("reads `defaultValue` — the spelling the ENTIRE shipped corpus uses", () => {
    // 4 params across 33 template YAMLs carry a default; all 4 spell it
    // `defaultValue` and none spells it `default`. Reading only the canonical
    // name makes default-application inert in production.
    expect(
      readPlaybookParams([{ name: "channel", defaultValue: "linkedin" }])
    ).toEqual([{ name: "channel", type: "text", default: "linkedin" }]);
  });

  it("NORMALIZES to `default` — the alias is read, never stored or re-emitted", () => {
    const [read] = readPlaybookParams([
      { name: "channel", defaultValue: "linkedin" },
    ]);
    expect(read).not.toHaveProperty("defaultValue");
  });

  it("the canonical `default` WINS when a bag carries both", () => {
    expect(
      readPlaybookParams([
        { name: "c", default: "canonical", defaultValue: "legacy" },
      ])
    ).toEqual([{ name: "c", type: "text", default: "canonical" }]);
  });

  it("returns [] for a non-array bag", () => {
    expect(readPlaybookParams(null)).toEqual([]);
    expect(readPlaybookParams({ name: "a" })).toEqual([]);
  });
});

describe("validatePlaybookParams — defaults", () => {
  it("APPLIES a default when the param is absent (the bug: defaults never reached the prompt)", () => {
    const r = validatePlaybookParams(
      [p({ name: "tone", default: "warm" })],
      {}
    );
    expect(r.values).toEqual({ tone: "warm" });
    expect(r.missingRequired).toEqual([]);
    expect(r.typeErrors).toEqual([]);
  });

  it("a default satisfies `required` — the caller is not asked for it", () => {
    const r = validatePlaybookParams(
      [p({ name: "tone", default: "warm", required: true })],
      undefined
    );
    expect(r.values).toEqual({ tone: "warm" });
    expect(r.missingRequired).toEqual([]);
  });

  it("a supplied value beats the default", () => {
    const r = validatePlaybookParams([p({ name: "tone", default: "warm" })], {
      tone: "blunt",
    });
    expect(r.values).toEqual({ tone: "blunt" });
  });

  it("a default that does not fit its own type is a typeError, flagged fromDefault", () => {
    const r = validatePlaybookParams(
      [p({ name: "n", type: "number", default: "not-a-number" })],
      {}
    );
    expect(r.values).toEqual({});
    expect(r.typeErrors).toEqual([
      {
        name: "n",
        type: "number",
        received: "not-a-number",
        fromDefault: true,
      },
    ]);
  });
});

describe("the `defaultValue` spelling — the only one the corpus uses", () => {
  /**
   * NON-VACUITY. Every assertion below is only meaningful if the fixture
   * really carries the legacy spelling; a later "tidy-up" to `default` would
   * leave the suite green while testing nothing. This pins the fixture itself.
   */
  const LEGACY = {
    name: "channel",
    type: "choice" as const,
    options: ["linkedin", "email"],
    defaultValue: "linkedin",
  };

  it("the fixture really uses the legacy spelling (non-vacuity)", () => {
    expect(Object.keys(LEGACY)).toContain("defaultValue");
    expect(Object.keys(LEGACY)).not.toContain("default");
  });

  it("the VALUE arrives in values[name] — not merely that a key is declared", () => {
    const r = validatePlaybookParams(readPlaybookParams([LEGACY]), {});
    expect(r.values.channel).toBe("linkedin");
    expect(r.declaredValues.channel).toBe("linkedin");
  });

  it("it SATISFIES required — the caller is not asked for it", () => {
    const r = validatePlaybookParams(
      readPlaybookParams([{ ...LEGACY, required: true }]),
      {}
    );
    expect(r.missingRequired).toEqual([]);
    expect(r.values.channel).toBe("linkedin");
  });

  it("a supplied value still beats a legacy-spelled default", () => {
    const r = validatePlaybookParams(readPlaybookParams([LEGACY]), {
      channel: "email",
    });
    expect(r.values.channel).toBe("email");
  });

  it("all four SHIPPED declarations resolve — not just the one I picked", () => {
    // The literal param shapes measured in workspace-templates/src/*.yaml.
    const shipped = [
      { name: "channel", defaultValue: "linkedin" },
      {
        name: "outputTypes",
        defaultValue:
          "a summary note, action-item tasks, and updated attendee records",
      },
      { name: "focus", defaultValue: "product, pricing, and positioning" },
      {
        name: "outputTypes2",
        defaultValue:
          "a head-to-head comparison summary and an updated competitor profile",
      },
    ];
    expect(shipped).toHaveLength(4); // non-vacuity: the measured count
    const r = validatePlaybookParams(readPlaybookParams(shipped), {});
    for (const p of shipped) {
      expect(r.values[p.name]).toBe(p.defaultValue);
    }
  });
});

describe("validatePlaybookParams — required", () => {
  it("collects a missing required param instead of throwing", () => {
    const declared = [p({ name: "who", type: "entity", required: true })];
    const r = validatePlaybookParams(declared, {});
    expect(r.missingRequired).toEqual(declared);
    expect(r.values).toEqual({});
  });

  it("a blank string does NOT satisfy required — an empty form field is not an answer", () => {
    const r = validatePlaybookParams([p({ name: "topic", required: true })], {
      topic: "   ",
    });
    expect(r.missingRequired.map((m) => m.name)).toEqual(["topic"]);
  });

  it("null is absent, not a value", () => {
    const r = validatePlaybookParams([p({ name: "topic", required: true })], {
      topic: null,
    });
    expect(r.missingRequired.map((m) => m.name)).toEqual(["topic"]);
  });

  it("an optional absent param is simply not in values (renders as it always did)", () => {
    const r = validatePlaybookParams([p({ name: "topic" })], {});
    expect(r.values).toEqual({});
    expect(r.missingRequired).toEqual([]);
    expect(r.typeErrors).toEqual([]);
  });

  it("false and 0 are real answers, not absences", () => {
    const r = validatePlaybookParams(
      [
        p({ name: "dry", type: "boolean", required: true }),
        p({ name: "n", type: "number", required: true }),
      ],
      { dry: false, n: 0 }
    );
    expect(r.values).toEqual({ dry: false, n: 0 });
    expect(r.missingRequired).toEqual([]);
  });
});

describe("validatePlaybookParams — types", () => {
  it("number: accepts a finite number and a numeric string; refuses NaN/Infinity/prose", () => {
    const declared = [p({ name: "n", type: "number" })];
    expect(validatePlaybookParams(declared, { n: 3 }).values).toEqual({ n: 3 });
    expect(validatePlaybookParams(declared, { n: " 3.5 " }).values).toEqual({
      n: 3.5,
    });
    expect(
      validatePlaybookParams(declared, { n: Number.NaN }).typeErrors
    ).toHaveLength(1);
    expect(
      validatePlaybookParams(declared, { n: Number.POSITIVE_INFINITY })
        .typeErrors
    ).toHaveLength(1);
    expect(validatePlaybookParams(declared, { n: "soon" }).typeErrors).toEqual([
      { name: "n", type: "number", received: "soon" },
    ]);
  });

  it("boolean: accepts booleans and the two string encodings; refuses anything else", () => {
    const declared = [p({ name: "b", type: "boolean" })];
    expect(validatePlaybookParams(declared, { b: true }).values).toEqual({
      b: true,
    });
    expect(validatePlaybookParams(declared, { b: "FALSE" }).values).toEqual({
      b: false,
    });
    expect(validatePlaybookParams(declared, { b: "yes" }).typeErrors).toEqual([
      { name: "b", type: "boolean", received: "yes" },
    ]);
  });

  it("entity: a uuid only", () => {
    const declared = [p({ name: "e", type: "entity" })];
    const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    expect(validatePlaybookParams(declared, { e: ` ${id} ` }).values).toEqual({
      e: id,
    });
    expect(
      validatePlaybookParams(declared, { e: "Acme Corp" }).typeErrors
    ).toEqual([{ name: "e", type: "entity", received: "Acme Corp" }]);
  });

  it("choice: must be one of options, and the options ride on the error", () => {
    const declared = [
      p({ name: "c", type: "choice", options: ["warm", "blunt"] }),
    ];
    expect(validatePlaybookParams(declared, { c: "warm" }).values).toEqual({
      c: "warm",
    });
    expect(validatePlaybookParams(declared, { c: "spicy" }).typeErrors).toEqual(
      [
        {
          name: "c",
          type: "choice",
          received: "spicy",
          options: ["warm", "blunt"],
        },
      ]
    );
  });

  it("choice with NO options accepts any string — an incomplete declaration does not brick the playbook", () => {
    const r = validatePlaybookParams([p({ name: "c", type: "choice" })], {
      c: "anything",
    });
    expect(r.values).toEqual({ c: "anything" });
    expect(r.typeErrors).toEqual([]);
  });

  it("text: a number/boolean stringifies (what the substituter already did); an object does not", () => {
    const declared = [p({ name: "t" })];
    expect(validatePlaybookParams(declared, { t: 3 }).values).toEqual({
      t: "3",
    });
    expect(
      validatePlaybookParams(declared, { t: { a: 1 } }).typeErrors
    ).toEqual([{ name: "t", type: "text", received: "object" }]);
  });

  it("a type error does NOT write the key and is not also reported as missing", () => {
    const r = validatePlaybookParams(
      [p({ name: "n", type: "number", required: true })],
      { n: "soon" }
    );
    expect(r.values).toEqual({});
    expect(r.missingRequired).toEqual([]);
    expect(r.typeErrors).toHaveLength(1);
  });
});

describe("the real corpus shape, end to end", () => {
  it("`outreach-comms` Personalized Outreach `channel` resolves to its default", () => {
    // The literal declaration from the shipped YAML, read then validated —
    // the seam that was inert before the alias arm existed.
    const declared = readPlaybookParams([
      {
        name: "channel",
        type: "choice",
        defaultValue: "linkedin",
        options: ["linkedin", "email"],
      },
    ]);
    expect(validatePlaybookParams(declared, {}).values).toEqual({
      channel: "linkedin",
    });
  });
});

describe("validatePlaybookParams — undeclared keys", () => {
  it("passes an undeclared supplied key through verbatim", () => {
    // A goal template may reference a name the playbook never declared; that
    // substituted before this function existed and must keep substituting.
    const r = validatePlaybookParams([p({ name: "a" })], {
      a: "x",
      undeclared: "y",
    });
    expect(r.values).toEqual({ a: "x", undeclared: "y" });
  });

  it("an undeclared key reaches `values` (substitution) but NOT `declaredValues` (storage)", () => {
    // The whole point of the split: `metadata.params` is a stored, rendered
    // bag, so arbitrary caller JSON must not land in it.
    const r = validatePlaybookParams([p({ name: "a" })], {
      a: "x",
      undeclared: { anything: [1, 2, 3] },
    });
    expect(r.values).toEqual({ a: "x", undeclared: { anything: [1, 2, 3] } });
    expect(r.declaredValues).toEqual({ a: "x" });
  });

  it("a defaulted param IS in declaredValues — a stored answer nobody typed is still an answer", () => {
    const r = validatePlaybookParams(
      [p({ name: "tone", default: "warm" })],
      {}
    );
    expect(r.declaredValues).toEqual({ tone: "warm" });
  });

  it("a playbook that declares nothing is the identity — today's behaviour exactly", () => {
    const r = validatePlaybookParams([], { any: 1, thing: "two" });
    expect(r.values).toEqual({ any: 1, thing: "two" });
    expect(r.missingRequired).toEqual([]);
    expect(r.typeErrors).toEqual([]);
  });
});

describe("describeMissingParams", () => {
  it("prefers the label, falls back to the name", () => {
    expect(
      describeMissingParams([
        p({ name: "who", label: "Who is this for" }),
        p({ name: "topic" }),
      ])
    ).toBe("Who is this for, topic");
  });
});
