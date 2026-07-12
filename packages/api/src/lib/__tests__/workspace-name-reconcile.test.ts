import { describe, it, expect } from "vitest";
import { reconcileWorkspaceByName } from "../workspace-name-reconcile.js";
import {
  BELOW_GATE_CONFIDENCE,
  EXACT_MATCH_CONFIDENCE,
  FUZZY_MATCH_CONFIDENCE,
} from "../ai-events.js";

/**
 * Locks the name→id reconciliation now that the IS actually propagates
 * `targetWorkspaceName` (Wave 2) — this path had never fired before, so its
 * behavior against REAL name+id pairs is verified here for the first time.
 */
describe("reconcileWorkspaceByName", () => {
  const CRM = "11111111-1111-1111-1111-111111111111";
  const BUILDER = "22222222-2222-2222-2222-222222222222";
  const FINANCE = "33333333-3333-3333-3333-333333333333";
  const workspaces = [
    { id: CRM, name: "CRM" },
    { id: BUILDER, name: "Builder" },
    { id: FINANCE, name: "Finance" },
  ];

  it("resolves an exact (case-insensitive) name to its real id — the copy-error fix", () => {
    const r = reconcileWorkspaceByName("crm", workspaces);
    expect(r).toEqual({
      resolvedWorkspaceId: CRM,
      derivedConfidence: EXACT_MATCH_CONFIDENCE,
      matchKind: "exact",
    });
  });

  it("resolves a name+id pair where the id was wrong to the name's real id", () => {
    // Real regression shape: the model named 'Finance' but copied CRM's UUID.
    // The caller applies `resolvedWorkspaceId`, overriding the transposed id.
    const r = reconcileWorkspaceByName("Finance", workspaces);
    expect(r?.resolvedWorkspaceId).toBe(FINANCE);
    expect(r?.resolvedWorkspaceId).not.toBe(CRM);
  });

  it("resolves a single unambiguous fuzzy match at fuzzy confidence", () => {
    const r = reconcileWorkspaceByName("the CRM workspace", workspaces);
    expect(r).toEqual({
      resolvedWorkspaceId: CRM,
      derivedConfidence: FUZZY_MATCH_CONFIDENCE,
      matchKind: "fuzzy-single",
    });
  });

  it("degrades an ambiguous multi-substring match to below-gate confidence", () => {
    const overlapping = [
      { id: BUILDER, name: "Builder" },
      { id: FINANCE, name: "Build Ops" },
    ];
    // "build" is a substring of BOTH names → arbitrary first pick, below gate.
    const r = reconcileWorkspaceByName("build", overlapping);
    expect(r?.matchKind).toBe("fuzzy-ambiguous");
    expect(r?.derivedConfidence).toBe(BELOW_GATE_CONFIDENCE);
  });

  it("returns null for a blank/whitespace name (the guarded latent bug)", () => {
    expect(reconcileWorkspaceByName("   ", workspaces)).toBeNull();
    expect(reconcileWorkspaceByName("", workspaces)).toBeNull();
    expect(reconcileWorkspaceByName(null, workspaces)).toBeNull();
    expect(reconcileWorkspaceByName(undefined, workspaces)).toBeNull();
  });

  it("does not let a blank workspace name substring-match every pick", () => {
    // `"".includes("")` is true — a blank ws name must NOT swallow a real pick.
    const withBlank = [{ id: CRM, name: "" }, ...workspaces];
    const r = reconcileWorkspaceByName("CRM", withBlank);
    expect(r?.resolvedWorkspaceId).toBe(CRM);
    expect(r?.matchKind).toBe("exact");
  });

  it("returns null when nothing matches", () => {
    expect(reconcileWorkspaceByName("Marketing", workspaces)).toBeNull();
    expect(reconcileWorkspaceByName("CRM", [])).toBeNull();
  });
});
