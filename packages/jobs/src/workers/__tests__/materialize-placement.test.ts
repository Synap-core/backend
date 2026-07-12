/**
 * Unit tests for the proposal → materializer placement read-back. This is the
 * enforcement half of invariant I3: a proposal-gated create/attach must land
 * EXACTLY where its auto-approved twin would. The create door persists the
 * resolved placement into proposal `data.resolvedWorkspaceId`; these tests prove
 * the materializer reads it back verbatim (present null wins) and only falls
 * back to the legacy derivation for pre-change proposals.
 */
import { describe, it, expect } from "vitest";
import {
  resolveMaterializedEntityWorkspaceId,
  resolveMaterializedFacetWorkspaceId,
} from "../materialize-placement.js";

const AMBIENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EXPLICIT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// The auto-approved placement values that the @synap/api resolver
// (resolveEntityWorkspacePlacement) produces — proven in that package's own
// suite. Here we prove the OTHER half of I3: whatever the door persisted as
// data.resolvedWorkspaceId is exactly what the materializer lands, so a
// proposal-gated write matches its auto-approved twin.
const POD_SCOPE_AUTO_APPROVED = null; // pod entityScope → NULL
const WORKSPACE_SCOPE_AUTO_APPROVED = AMBIENT; // workspace entityScope → ambient

describe("resolveMaterializedEntityWorkspaceId", () => {
  it("(d) I3: pod-scope create materializes to the SAME NULL the auto-approved path resolves", () => {
    const data = {
      global: false,
      resolvedWorkspaceId: POD_SCOPE_AUTO_APPROVED,
    };
    // Ambient is non-null, yet the pod-scope entity must still land pod-wide.
    expect(resolveMaterializedEntityWorkspaceId(data, AMBIENT)).toBe(
      POD_SCOPE_AUTO_APPROVED
    );
    expect(resolveMaterializedEntityWorkspaceId(data, AMBIENT)).toBeNull();
  });

  it("(d) I3: workspace-scope create materializes to the SAME ambient workspace", () => {
    const data = { resolvedWorkspaceId: WORKSPACE_SCOPE_AUTO_APPROVED };
    expect(resolveMaterializedEntityWorkspaceId(data, AMBIENT)).toBe(AMBIENT);
  });

  it("a persisted explicit target is read back verbatim", () => {
    const data = { resolvedWorkspaceId: EXPLICIT };
    // Ambient is a DIFFERENT workspace — must NOT override the persisted value.
    expect(resolveMaterializedEntityWorkspaceId(data, AMBIENT)).toBe(EXPLICIT);
  });

  it("a persisted null wins over the ambient workspace (the four-door bug)", () => {
    const data = { resolvedWorkspaceId: null };
    expect(resolveMaterializedEntityWorkspaceId(data, AMBIENT)).toBeNull();
  });

  it("(e) legacy proposal (no resolvedWorkspaceId, non-global) falls back to the ambient workspace", () => {
    const data = { global: false, profileSlug: "note" };
    expect(resolveMaterializedEntityWorkspaceId(data, AMBIENT)).toBe(AMBIENT);
  });

  it("(e) legacy proposal with global=true falls back to NULL", () => {
    const data = { global: true };
    expect(resolveMaterializedEntityWorkspaceId(data, AMBIENT)).toBeNull();
  });
});

describe("resolveMaterializedFacetWorkspaceId", () => {
  it("reads the persisted facet lens verbatim, including a pod-wide NULL", () => {
    expect(
      resolveMaterializedFacetWorkspaceId(
        { resolvedWorkspaceId: null },
        AMBIENT
      )
    ).toBeNull();
    expect(
      resolveMaterializedFacetWorkspaceId(
        { resolvedWorkspaceId: EXPLICIT },
        AMBIENT
      )
    ).toBe(EXPLICIT);
  });

  it("(e) legacy facet proposal falls back to data.workspaceId, else ambient", () => {
    expect(
      resolveMaterializedFacetWorkspaceId({ workspaceId: EXPLICIT }, AMBIENT)
    ).toBe(EXPLICIT);
    expect(resolveMaterializedFacetWorkspaceId({}, AMBIENT)).toBe(AMBIENT);
  });
});
