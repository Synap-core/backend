import { describe, it, expect } from "vitest";
import { AskSchema } from "@synap-core/types/ask";
import {
  ASK_SKILL_HINT,
  ASK_SKILL_REF,
  buildAskWireSchema,
} from "./ask-wire-schema.js";

/**
 * The compact wire `ask` is LOOSE; the server stays STRICT (`AskSchema`).
 * Every ask the strict schema accepts must pass the loose one (nothing that was
 * valid becomes unsendable), the loose one must stay small, and the strict one
 * must still refuse a wrong shape.
 */
const wire = buildAskWireSchema() as {
  properties: Record<string, { type?: string; enum?: string[] }>;
  required: string[];
};

// A minimal structural check of a value against the loose schema (type + enum + required).
function passesWire(ask: Record<string, unknown>): string[] {
  const bad: string[] = [];
  for (const r of wire.required) if (!(r in ask)) bad.push(`missing ${r}`);
  for (const [k, v] of Object.entries(ask)) {
    const p = wire.properties[k];
    if (!p) continue; // loose: unknown keys are allowed on the wire
    const t = Array.isArray(v) ? "array" : typeof v;
    if (p.type && t !== p.type) bad.push(`${k}: ${t} is not ${p.type}`);
    if (p.enum && !p.enum.includes(v as string)) bad.push(`${k}: ${String(v)}`);
  }
  return bad;
}

const media = { kind: "image", ref: { url: "https://x.test/a.png" }, alt: "a" };
const shared = {
  risk: "high",
  stakes: "commitment",
  urgency: "whenever",
  answerBy: "2026-11-05T17:00:00Z",
  consequence: "Publishes the post",
  reversible: false,
  dedupeKey: "k1",
  lookedAt: [{ kind: "entity", id: "e1" }],
};
const VALID: Array<[string, Record<string, unknown>]> = [
  ["confirm bare", { mode: "confirm" }],
  [
    "confirm full",
    {
      mode: "confirm",
      prompt: "Ship?",
      yes: { label: "Yes", description: "Goes live", recommended: true },
      no: { description: "Draft" },
      ...shared,
    },
  ],
  [
    "choose",
    {
      mode: "choose",
      options: [
        { label: "A", recommended: true, description: "d", caution: "c" },
        { label: "B", value: "b", icon: "i" },
      ],
      allowOther: false,
    },
  ],
  [
    "choose followUp + media",
    {
      mode: "choose",
      options: [
        {
          label: "Deploy",
          media,
          followUp: {
            prompt: "Where?",
            options: [
              { label: "staging", media },
              { label: "prod", caution: "Live" },
            ],
          },
        },
      ],
    },
  ],
  [
    "form",
    {
      mode: "form",
      form: {
        title: "t",
        note: "n",
        fields: [
          {
            key: "k",
            label: "L",
            type: "text",
            required: true,
            help: "h",
            constraints: { enum: ["a"], min: 1, max: 2, pattern: "x" },
          },
        ],
      },
      ...shared,
    },
  ],
  ["act", { mode: "act", url: "https://x.test", steps: ["one", "two"] }],
  [
    "provide connection",
    { mode: "provide", provide: { kind: "connection", service: "github" } },
  ],
  [
    "provide file",
    { mode: "provide", provide: { kind: "file", accept: ["image/png"] } },
  ],
  [
    "provide secret",
    { mode: "provide", provide: { kind: "secret", name: "STRIPE_KEY" } },
  ],
];

describe("compact ask wire schema", () => {
  it.each(VALID)("%s: strict-valid and wire-valid", (_n, ask) => {
    expect(
      AskSchema.safeParse(ask).success,
      JSON.stringify(AskSchema.safeParse(ask))
    ).toBe(true);
    expect(passesWire(ask)).toEqual([]);
  });

  it("the server still refuses wrong shapes (strict stays strict)", () => {
    for (const bad of [
      { mode: "choose" }, // no options
      {
        mode: "choose",
        options: [
          { label: "A", recommended: true },
          { label: "B", recommended: true },
        ],
      },
      {
        mode: "form",
        form: { fields: [{ key: "pw", label: "Password", type: "password" }] },
      },
      { mode: "provide", provide: { kind: "secret" } },
      { mode: "teleport" },
    ]) {
      expect(AskSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is one flat object that names the skill, and stays small", () => {
    const json = JSON.stringify(buildAskWireSchema());
    expect(json).not.toContain("oneOf");
    expect(json).toContain(ASK_SKILL_REF);
    expect(ASK_SKILL_HINT).toContain(ASK_SKILL_REF);
    expect(json.length).toBeLessThan(2_200); // was 12-14K chars per copy
  });
});
