/**
 * The template re-apply must be ADDITIVE with respect to verbs it does not
 * declare, and its result must satisfy `capabilityVerbCatalogDrift`'s subset
 * comparator on the very next pass. If those two ever disagree, reconcile
 * detects drift, applies, and detects the same drift again — a re-apply loop on
 * every single boot. That round-trip is what this file pins.
 */

import { describe, expect, it } from "vitest";
import type { ToolVerbCatalogEntry } from "@synap/database/schema";
import { mergeVerbCatalog, upsertVerbCatalogEntry } from "./verb-catalog.js";
import { capabilityVerbCatalogDrift } from "./capability-drift.js";
import { deriveToolVerbs } from "./create-from-definition.js";
import type { CapabilitySkillDef } from "@synap/playbooks";

const userVerb: ToolVerbCatalogEntry = {
  id: "linear_my_custom_query",
  label: "linear_my_custom_query",
  kind: "read",
  govDefault: "propose",
};

/** A template declaring two verbs on the tool `linear`, one carrying `intent`. */
const templateSkills = [
  {
    name: "linear_create_issue",
    description: "Create an issue",
    requires: ["linear"],
    parameters: { type: "object", properties: {} },
    intent: "run_external_job",
  },
  {
    name: "linear_list_issues",
    description: "List issues",
    requires: ["linear"],
    parameters: { type: "object", properties: {} },
  },
] as unknown as CapabilitySkillDef[];

function project(): ToolVerbCatalogEntry[] {
  return deriveToolVerbs("linear", templateSkills, "propose");
}

describe("mergeVerbCatalog", () => {
  it("preserves a live verb the template does not declare", () => {
    const merged = mergeVerbCatalog([userVerb], project());
    expect(merged.map((v) => v.id)).toEqual([
      "linear_my_custom_query",
      "linear_create_issue",
      "linear_list_issues",
    ]);
    expect(merged[0]).toEqual(userVerb);
  });

  it("re-projects a declared verb, carrying `intent` onto the pod", () => {
    const stale: ToolVerbCatalogEntry = {
      id: "linear_create_issue",
      label: "linear_create_issue",
      kind: "read",
      govDefault: "propose",
    };
    const merged = mergeVerbCatalog([stale, userVerb], project());
    const live = merged.find((v) => v.id === "linear_create_issue");
    expect(live?.intent).toBe("run_external_job");
    // Position preserved on replace — a churning array order reads as drift.
    expect(merged.map((v) => v.id)).toEqual([
      "linear_create_issue",
      "linear_my_custom_query",
      "linear_list_issues",
    ]);
  });

  it("is idempotent — a second merge of the same projection is a no-op", () => {
    const once = mergeVerbCatalog([userVerb], project());
    expect(mergeVerbCatalog(once, project())).toEqual(once);
  });

  it("handles a null/absent live catalog", () => {
    expect(mergeVerbCatalog(null, project()).map((v) => v.id)).toEqual([
      "linear_create_issue",
      "linear_list_issues",
    ]);
  });

  it("is exactly a fold of the single-entry upsert (one implementation)", () => {
    expect(mergeVerbCatalog([userVerb], project())).toEqual(
      project().reduce(upsertVerbCatalogEntry, [userVerb])
    );
  });
});

describe("re-apply round-trip vs capabilityVerbCatalogDrift", () => {
  const projectedByTool = new Map([["linear", project()]]);

  it("a tool carrying one user verb plus stale template verbs reports drift", () => {
    const live: ToolVerbCatalogEntry[] = [
      userVerb,
      {
        id: "linear_create_issue",
        label: "linear_create_issue",
        kind: "read",
        govDefault: "propose",
      },
    ];
    expect(
      capabilityVerbCatalogDrift(
        [{ name: "linear", capabilityCatalog: live }],
        projectedByTool
      ).drifted
    ).toEqual(["linear"]);
  });

  it("converges a catalogue carrying DUPLICATE ids, with no drift on the next pass", () => {
    // Legacy shape: entries were appended before the array was id-keyed, so the
    // same verb can appear twice. The applier replaces the FIRST match while the
    // drift comparator's Map keeps the LAST — left alone, that disagreement
    // re-applies this tool on every boot, forever.
    const stale: ToolVerbCatalogEntry = {
      id: "linear_create_issue",
      label: "linear_create_issue",
      kind: "read",
      govDefault: "propose",
    };
    const live: ToolVerbCatalogEntry[] = [stale, { ...stale }, userVerb];

    const converged = mergeVerbCatalog(live, project());

    expect(
      capabilityVerbCatalogDrift(
        [{ name: "linear", capabilityCatalog: converged }],
        projectedByTool
      ).drifted
    ).toEqual([]);
    // The duplicate is collapsed, so no stale copy survives to be read back.
    expect(
      converged.filter((v) => v.id === "linear_create_issue")
    ).toHaveLength(1);
    expect(converged).toContainEqual(userVerb);
  });

  it("converges, then reports NO drift on the immediately following pass", () => {
    const live: ToolVerbCatalogEntry[] = [
      userVerb,
      {
        id: "linear_create_issue",
        label: "linear_create_issue",
        kind: "read",
        govDefault: "propose",
      },
    ];
    // What the applier now writes.
    const converged = mergeVerbCatalog(live, project());
    // The user verb survived the re-apply — the bug this fix closes.
    expect(converged).toContainEqual(userVerb);

    // Next boot's pass over the SAME rows: no drift ⇒ no re-apply loop.
    expect(
      capabilityVerbCatalogDrift(
        [{ name: "linear", capabilityCatalog: converged }],
        projectedByTool
      ).drifted
    ).toEqual([]);
  });
});
