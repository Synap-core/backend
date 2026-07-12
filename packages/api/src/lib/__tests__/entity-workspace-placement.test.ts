/**
 * Unit tests for the pure entity workspace-placement precedence — the ONE
 * resolver every create door (inline K1, hub K2, n8n N7, proposal N1) shares.
 * Proving it here proves the four-door bug can't reappear at the placement
 * layer: the same input always resolves to the same workspace.
 */
import { describe, it, expect } from "vitest";
import { resolveEntityWorkspacePlacement } from "../entity-workspace-placement.js";

const AMBIENT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EXPLICIT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("resolveEntityWorkspacePlacement", () => {
  it("(a) pod-scope profile → NULL (pod-wide), ignoring the ambient workspace", () => {
    expect(
      resolveEntityWorkspacePlacement({
        global: false,
        workspaceScoped: false,
        profileEntityScope: "pod",
        ambientWorkspaceId: AMBIENT,
      })
    ).toBeNull();
  });

  it("(b) workspace-scope profile → the ambient workspace (unchanged behavior)", () => {
    expect(
      resolveEntityWorkspacePlacement({
        global: false,
        workspaceScoped: false,
        profileEntityScope: "workspace",
        ambientWorkspaceId: AMBIENT,
      })
    ).toBe(AMBIENT);
  });

  it("defaults an undefined entityScope to workspace-scope → ambient", () => {
    expect(
      resolveEntityWorkspacePlacement({
        global: false,
        workspaceScoped: false,
        profileEntityScope: undefined,
        ambientWorkspaceId: AMBIENT,
      })
    ).toBe(AMBIENT);
  });

  it("(c) explicit targetWorkspaceId wins over a pod-scope profile", () => {
    expect(
      resolveEntityWorkspacePlacement({
        global: false,
        targetWorkspaceId: EXPLICIT,
        workspaceScoped: false,
        profileEntityScope: "pod",
        ambientWorkspaceId: AMBIENT,
      })
    ).toBe(EXPLICIT);
  });

  it("global flag → NULL, even with an explicit target present", () => {
    expect(
      resolveEntityWorkspacePlacement({
        global: true,
        targetWorkspaceId: EXPLICIT,
        workspaceScoped: false,
        profileEntityScope: "pod",
        ambientWorkspaceId: AMBIENT,
      })
    ).toBeNull();
  });

  it("workspaceScoped pins a pod-scope profile to the ambient workspace (import isolation)", () => {
    expect(
      resolveEntityWorkspacePlacement({
        global: false,
        workspaceScoped: true,
        profileEntityScope: "pod",
        ambientWorkspaceId: AMBIENT,
      })
    ).toBe(AMBIENT);
  });

  it("pod-scope with a NULL ambient workspace still resolves to NULL", () => {
    expect(
      resolveEntityWorkspacePlacement({
        global: false,
        workspaceScoped: false,
        profileEntityScope: "pod",
        ambientWorkspaceId: null,
      })
    ).toBeNull();
  });
});
