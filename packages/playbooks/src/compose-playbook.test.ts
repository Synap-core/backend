/**
 * Composition (base + overlay) tests — the NET-NEW playbook substrate.
 *
 * Proves a base conversion journey + a per-source overlay flatten to ONE
 * concrete playbook: base stages + overlay stages merged (by key), grants /
 * params / expectedOutputs unioned, and overlay scalars winning — exactly the
 * additive contract workstream D authors its cold-outreach / inbound-nurture /
 * referral overlays against.
 */

import { describe, it, expect } from "vitest";
import {
  composePlaybookDef,
  resolveComposedPlaybooks,
  type LoopDefinition,
  type LoopPlaybookDef,
} from "./index.js";

const base: LoopPlaybookDef = {
  ref: "conversion-base",
  name: "Conversion Journey",
  goalTemplate: "Convert {{lead}} into a customer",
  description: "Shared base journey",
  executor: "is-agent",
  channelSpec: { type: "THREAD" },
  params: [{ name: "lead", type: "entity", required: true }],
  grants: [
    { kind: "tool", id: "email" },
    { kind: "skill", id: "draft-message" },
  ],
  expectedOutputs: [{ kind: "note", label: "Journey log" }],
  stages: [
    { key: "qualify", name: "Qualify", grants: [{ kind: "tool", id: "crm" }] },
    { key: "nurture", name: "Nurture" },
    { key: "close", name: "Close" },
  ],
  subjectProfile: { profileSlug: "person" },
};

describe("composePlaybookDef", () => {
  it("merges stages by key, unions grants, and overlay scalars win", () => {
    const overlay: LoopPlaybookDef = {
      ref: "cold-outreach",
      name: "Cold Outreach Conversion",
      goalTemplate: "Cold-outreach {{lead}} from scratch",
      extends: "conversion-base",
      // adds a source-specific first stage + augments the shared "qualify" stage
      stages: [
        { key: "research", name: "Research prospect" },
        { key: "qualify", grants: [{ kind: "tool", id: "linkedin" }] },
      ],
      grants: [{ kind: "tool", id: "linkedin" }],
      params: [{ name: "sequence", type: "text" }],
      expectedOutputs: [{ kind: "task", label: "Follow-ups" }],
    };

    const out = composePlaybookDef(base, overlay);

    // ref is the overlay's concrete ref; extends is dropped.
    expect(out.ref).toBe("cold-outreach");
    expect(out.extends).toBeUndefined();

    // overlay scalars win.
    expect(out.name).toBe("Cold Outreach Conversion");
    expect(out.goalTemplate).toBe("Cold-outreach {{lead}} from scratch");
    // base scalars survive when overlay omits them.
    expect(out.description).toBe("Shared base journey");
    expect(out.executor).toBe("is-agent");
    expect(out.channelSpec).toEqual({ type: "THREAD" });
    expect(out.subjectProfile).toEqual({ profileSlug: "person" });

    // stages: base order preserved, new overlay key appended, matched key merged.
    expect(out.stages?.map((s) => s.key)).toEqual([
      "qualify",
      "nurture",
      "close",
      "research",
    ]);
    const qualify = out.stages?.find((s) => s.key === "qualify")!;
    // matched stage keeps base name and unions grants (crm + linkedin).
    expect(qualify.name).toBe("Qualify");
    expect(qualify.grants).toEqual([
      { kind: "tool", id: "crm" },
      { kind: "tool", id: "linkedin" },
    ]);

    // grants unioned at the playbook level.
    expect(out.grants).toEqual([
      { kind: "tool", id: "email" },
      { kind: "skill", id: "draft-message" },
      { kind: "tool", id: "linkedin" },
    ]);

    // params unioned by name; expectedOutputs unioned by kind.
    expect(out.params?.map((p) => p.name)).toEqual(["lead", "sequence"]);
    expect(out.expectedOutputs?.map((o) => o.kind)).toEqual(["note", "task"]);
  });

  it("dedups grants by kind+id (overlay repeating a base grant is not duplicated)", () => {
    const overlay: LoopPlaybookDef = {
      ref: "referral",
      name: "Referral",
      goalTemplate: "Convert referral {{lead}}",
      extends: "conversion-base",
      grants: [{ kind: "tool", id: "email" }], // already in base
    };
    const out = composePlaybookDef(base, overlay);
    expect(out.grants).toEqual([
      { kind: "tool", id: "email" },
      { kind: "skill", id: "draft-message" },
    ]);
  });
});

describe("resolveComposedPlaybooks", () => {
  it("flattens overlays and passes plain playbooks through unchanged", () => {
    const standalone: LoopPlaybookDef = {
      ref: "standalone",
      name: "Standalone",
      goalTemplate: "Do a thing",
    };
    const def: LoopDefinition = {
      key: "conversion-loop",
      name: "Conversion",
      basePlaybooks: [base],
      playbooks: [
        {
          ref: "inbound-nurture",
          name: "Inbound Nurture",
          goalTemplate: "Nurture inbound {{lead}}",
          extends: "conversion-base",
          stages: [{ key: "welcome", name: "Welcome email" }],
        },
        standalone,
      ],
    };

    const resolved = resolveComposedPlaybooks(def);

    // bases are never returned; both playbooks are, overlay flattened.
    expect(resolved.map((p) => p.ref)).toEqual([
      "inbound-nurture",
      "standalone",
    ]);
    const inbound = resolved[0];
    expect(inbound.extends).toBeUndefined();
    // base stages + overlay stage.
    expect(inbound.stages?.map((s) => s.key)).toEqual([
      "qualify",
      "nurture",
      "close",
      "welcome",
    ]);
    // plain playbook untouched.
    expect(resolved[1]).toBe(standalone);
  });

  it("throws when an overlay extends an unknown base", () => {
    const def: LoopDefinition = {
      key: "broken",
      name: "Broken",
      playbooks: [
        {
          ref: "orphan",
          name: "Orphan",
          goalTemplate: "x",
          extends: "does-not-exist",
        },
      ],
    };
    expect(() => resolveComposedPlaybooks(def)).toThrow(/unknown base/);
  });
});
