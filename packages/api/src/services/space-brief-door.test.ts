import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(),
}));

const { patchStoredBrief, spaceBriefPatchSchema } =
  await import("./space-brief-door.js");
const { buildProposalChanges } =
  await import("../routers/proposals/changes.js");
const { diffSpaceBrief, normalizeSpaceBrief } =
  await import("@synap-core/types/space-brief");

/** As a YAML `>` block lands in the DB: a trailing newline, unnormalized. */
const STORED = {
  goal: "Capture the brand",
  framing: "THE BRAND STRATEGIST\n",
  collect: [{ profileSlug: "brand-identity", what: "Identity" }],
  rules: [{ key: "assets-first", ruleId: "r-1" }],
};

describe("update_brief — the narrow patch", () => {
  it("changes ONLY the named fields; untouched ones keep their stored bytes", () => {
    const next = patchStoredBrief(STORED, {
      purpose: "  The brand's source of truth. ",
      doneWhen: null,
    });
    expect(next.purpose).toBe("The brand's source of truth.");
    // Byte-identical, NOT re-normalized — the template reconcile's three-way
    // stamp must still read this field as untouched.
    expect(next.framing).toBe("THE BRAND STRATEGIST\n");
    expect(next.collect).toBe(STORED.collect);
    expect(next.rules).toBe(STORED.rules);
    expect("doneWhen" in next).toBe(false);
  });

  it("null removes a field", () => {
    const next = patchStoredBrief(STORED, { goal: null });
    expect("goal" in next).toBe(false);
    expect(next.framing).toBe(STORED.framing);
  });

  it("the wire schema refuses rule refs and unknown keys (rules change through the rule door)", () => {
    expect(spaceBriefPatchSchema.safeParse({ rules: [] }).success).toBe(false);
    expect(spaceBriefPatchSchema.safeParse({ bogus: 1 }).success).toBe(false);
    expect(
      spaceBriefPatchSchema.safeParse({
        anchors: [{ profileSlug: "brand-identity", role: "root", limit: 1 }],
        fetch: [{ query: "logo" }],
      }).success
    ).toBe(true);
    expect(
      spaceBriefPatchSchema.safeParse({ fetch: [{ note: "x" }] }).success
    ).toBe(false);
  });

  it("the review card renders one row per changed brief field, labelled through the vocabulary", () => {
    const before = normalizeSpaceBrief(STORED);
    const after = normalizeSpaceBrief(
      patchStoredBrief(STORED, {
        purpose: "P",
        doneWhen: null,
        framing: "New voice",
        anchors: [{ profileSlug: "brand-identity", role: "root" }],
      })
    );
    const rows = buildProposalChanges(
      {
        id: "ws-1",
        operation: "update_brief",
        patch: {},
        brief: { before, after },
        changes: diffSpaceBrief(before, after),
      },
      "update"
    );
    expect(
      rows.map((r) => [r.path, r.label, r.operation, r.before, r.after])
    ).toEqual([
      ["onboarding.purpose", "Purpose", "create", undefined, "P"],
      [
        "onboarding.framing",
        "Persona",
        "update",
        "THE BRAND STRATEGIST",
        "New voice",
      ],
      [
        "onboarding.anchors",
        "Read first",
        "create",
        undefined,
        [{ profileSlug: "brand-identity", role: "root" }],
      ],
    ]);
  });
});
