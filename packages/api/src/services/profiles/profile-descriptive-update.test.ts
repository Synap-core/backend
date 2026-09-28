/**
 * The descriptive-update diff (change, not presence; merge, never drop) and the
 * title the reviewer reads — asserted THROUGH `buildProposalSummary`, the one
 * summary door the gate stores, not only through the helper.
 */
import { describe, expect, it } from "vitest";
import {
  buildDescriptiveProfileUpdateSummary,
  diffDescriptiveProfileFields,
} from "./profile-descriptive-update.js";
import { buildProposalSummary } from "../../utils/permission-check.js";

const EXISTING = {
  displayName: "GRP interrogation",
  uiHints: { icon: "help", description: "Growth Research Positioning" },
  defaultValues: { grp_domain: "Growth", other: "kept" },
};

describe("diffDescriptiveProfileFields", () => {
  it("absent or equal fields change nothing", () => {
    expect(
      diffDescriptiveProfileFields(EXISTING, {
        displayName: "GRP interrogation",
        uiHints: { description: "Growth Research Positioning" },
        defaultValues: { grp_domain: "Growth" },
      })
    ).toEqual({ changed: [], patch: {} });
    expect(diffDescriptiveProfileFields(EXISTING, {})).toEqual({
      changed: [],
      patch: {},
    });
  });

  it("a changed description + default merges, keeping every other key", () => {
    expect(
      diffDescriptiveProfileFields(EXISTING, {
        uiHints: { description: "Génération · Rémunération · Partage" },
        defaultValues: { grp_domain: "Génération" },
      })
    ).toEqual({
      changed: ["description", "defaultValues"],
      patch: {
        uiHints: {
          icon: "help",
          description: "Génération · Rémunération · Partage",
        },
        defaultValues: { grp_domain: "Génération", other: "kept" },
      },
    });
  });

  it("a rename is a change; whitespace alone is not", () => {
    expect(
      diffDescriptiveProfileFields(EXISTING, {
        displayName: " GRP interrogation ",
      }).changed
    ).toEqual([]);
    expect(
      diffDescriptiveProfileFields(EXISTING, { displayName: "GRP questions" })
    ).toEqual({
      changed: ["displayName"],
      patch: { displayName: "GRP questions" },
    });
  });
});

describe("the review title", () => {
  const data = {
    id: "role-1",
    slug: "grp-interrogation",
    displayName: "GRP interrogation",
    profileKind: "role",
    updateExistingProfile: true,
    changedFields: ["description", "defaultValues"],
    previousDisplayName: "GRP interrogation",
  };

  it("names the role and what changes — through buildProposalSummary", () => {
    const title = buildProposalSummary("profile", "create", data);
    expect(title).toBe(buildDescriptiveProfileUpdateSummary(data));
    expect(title).toMatch(
      /^Update .*"GRP interrogation": description, default values$/
    );
    expect(title).not.toMatch(/^Create/);
  });

  it("a rename says the new name", () => {
    expect(
      buildDescriptiveProfileUpdateSummary({
        ...data,
        displayName: "GRP questions",
        changedFields: ["displayName"],
      })
    ).toMatch(
      /"GRP interrogation": display name \(renamed to "GRP questions"\)$/
    );
  });
});
