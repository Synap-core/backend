/**
 * `requires` on a lifecycle option (status-first wave, research bf4dc995
 * option B step 5): what a thing standing in a step must HAVE before it moves
 * on. A closed, typed list (`link` | `property`) parsed by the one parser
 * every declaring door uses (`parseLifecycleOptions`): it survives the
 * stored-option mapper, a bad entry is reported without dropping the option,
 * and a finished option requires nothing. The parity test beside it
 * (`lifecycle-step-waits.test.ts`) keeps every field through the mapper.
 */
import { describe, it, expect } from "vitest";
import { parseLifecycleOptions } from "./lifecycle-model.js";
import { normalizeEnumOptions } from "./property-enum.js";

const CONTACT = {
  kind: "link",
  blockerKey: "no_contact",
  relation: "works_at",
  direction: "in",
  clearedBy: { playbookId: "find-right-contact" },
  forKinds: ["company"],
};
const LINKEDIN = {
  kind: "property",
  blockerKey: "no_linkedin",
  label: "Their LinkedIn profile",
  property: "linkedinUrl",
  owner: "agent",
  clearedBy: { capability: "linkedin.find_profile" },
  forKinds: ["person"],
};

describe("requires", () => {
  it("is kept on an open/active/paused option, through both mappers", () => {
    const authored = [
      { key: "new", category: "open" },
      { key: "outreach", category: "active", requires: [CONTACT, LINKEDIN] },
      {
        key: "sent",
        category: "active",
        requires: [
          {
            kind: "property",
            blockerKey: "no_amount",
            property: "amount",
            in: ["a", "b", "a"],
          },
        ],
      },
      { key: "won", category: "done" },
    ];
    const parsed = parseLifecycleOptions(authored);
    expect(parsed.errors).toEqual([]);
    const requires = (os: Array<{ requires?: unknown }>) =>
      os.map((o) => o.requires);
    const expected = [
      undefined,
      [CONTACT, LINKEDIN],
      [
        {
          kind: "property",
          blockerKey: "no_amount",
          property: "amount",
          in: ["a", "b"],
        },
      ],
      undefined,
    ];
    expect(requires(parsed.options)).toEqual(expected);
    const stored = normalizeEnumOptions(parsed.options)!;
    expect(requires(stored)).toEqual(expected);
    expect(requires(parseLifecycleOptions(stored).options)).toEqual(expected);
  });

  it("a bad requirement is reported, and the option stays without it", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ kind: "link" }, /must be a list/],
      [["x"], /requires\[0\] must be an object/],
      [[{ ...CONTACT, blockerKey: "No Contact" }], /blockerKey must be/],
      [[CONTACT, { ...LINKEDIN, blockerKey: "no_contact" }], /declared twice/],
      [
        [{ ...CONTACT, kind: "expression" }],
        /kind must be "link" or "property"/,
      ],
      [[{ ...CONTACT, relation: "works at" }], /relation must name/],
      [[{ ...CONTACT, direction: "both" }], /direction must be/],
      [[{ ...CONTACT, min: 0 }], /min must be a whole number/],
      [[{ ...CONTACT, min: 1.5 }], /min must be a whole number/],
      [[{ ...LINKEDIN, property: "" }], /property must name/],
      [[{ ...LINKEDIN, in: [] }], /in must be a non-empty list/],
      [[{ ...LINKEDIN, owner: "them" }], /owner must be one of you \| agent/],
      [[{ ...LINKEDIN, clearedBy: { run: "x" } }], /clearedBy must be one of/],
      [
        [{ ...LINKEDIN, clearedBy: { intent: "a", capability: "b" } }],
        /clearedBy must be one of/,
      ],
      [[{ ...LINKEDIN, forKinds: [] }], /forKinds must be a list/],
      [[{ ...LINKEDIN, when: "channel=linkedin" }], /unknown field\(s\): when/],
      [[{ ...CONTACT, in: ["x"] }], /unknown field\(s\): in/],
    ];
    for (const [requires, message] of cases) {
      const parsed = parseLifecycleOptions([
        { key: "outreach", category: "active", requires },
      ]);
      expect(parsed.errors.join(" ")).toMatch(message);
      expect(parsed.options.map((o) => o.key)).toEqual(["outreach"]);
      expect(parsed.options[0]!.requires).toBeUndefined();
    }
  });

  it("a finished option requires nothing", () => {
    for (const category of ["done", "lost"]) {
      const parsed = parseLifecycleOptions([
        { key: "x", category, requires: [CONTACT] },
      ]);
      expect(parsed.errors.join(" ")).toMatch(/requires nothing/);
      expect(parsed.options[0]!.requires).toBeUndefined();
    }
  });
});
