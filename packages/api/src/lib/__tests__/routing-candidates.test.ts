/**
 * Unit tests for the routable-workspace-type predicate (candidate hygiene).
 * Proves the D2 exclusion (agent workspaces) and the operational exclusion.
 * (Archived exclusion is enforced at the SQL layer — `archivedAt IS NULL` — so
 * archived rows never reach this JS filter and can't be unit-tested here.)
 */
import { describe, it, expect } from "vitest";
import { isRoutableWorkspaceType } from "../routing-candidates.js";

describe("isRoutableWorkspaceType", () => {
  it("excludes agent workspaces (D2)", () => {
    expect(isRoutableWorkspaceType("agent")).toBe(false);
  });

  it("excludes operational workspaces (pod-admin etc.)", () => {
    expect(isRoutableWorkspaceType("operational")).toBe(false);
  });

  it("routes user-data workspace types", () => {
    expect(isRoutableWorkspaceType("personal")).toBe(true);
    expect(isRoutableWorkspaceType("project")).toBe(true);
  });

  it("routes an unset/unknown type (fail-open to routable — only the two named types are excluded)", () => {
    expect(isRoutableWorkspaceType(null)).toBe(true);
    expect(isRoutableWorkspaceType(undefined)).toBe(true);
  });
});
