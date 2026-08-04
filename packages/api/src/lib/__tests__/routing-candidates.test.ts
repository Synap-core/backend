/**
 * Unit tests for routable / domain-home workspace predicates (candidate hygiene).
 * Proves the D2 exclusion (agent), operational exclusion, surfaceClass admin/
 * settings, and systemSlug pod-admin (legacy personal-typed admin rows).
 * (Archived exclusion is SQL-layer — `archivedAt IS NULL` — not unit-tested here.)
 */
import { describe, it, expect } from "vitest";
import {
  isRoutableWorkspaceType,
  isDomainHomeWorkspace,
} from "../routing-candidates.js";

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

describe("isDomainHomeWorkspace", () => {
  it("excludes operational and agent types", () => {
    expect(isDomainHomeWorkspace({ workspaceType: "operational" })).toBe(false);
    expect(isDomainHomeWorkspace({ workspaceType: "agent" })).toBe(false);
  });

  it("excludes surfaceClass admin|settings even when type is personal", () => {
    expect(
      isDomainHomeWorkspace({
        workspaceType: "personal",
        settings: { surfaceClass: "admin" },
      })
    ).toBe(false);
    expect(
      isDomainHomeWorkspace({
        workspaceType: "personal",
        settings: { surfaceClass: "settings" },
      })
    ).toBe(false);
  });

  it("excludes systemSlug pod-admin without name hardcoding (legacy personal-typed)", () => {
    expect(
      isDomainHomeWorkspace({
        workspaceType: "personal",
        systemSlug: "pod-admin",
      })
    ).toBe(false);
    expect(
      isDomainHomeWorkspace({
        workspaceType: "personal",
        settings: { systemSlug: "pod-admin" },
      })
    ).toBe(false);
  });

  it("allows personal/project domain homes", () => {
    expect(isDomainHomeWorkspace({ workspaceType: "personal" })).toBe(true);
    expect(isDomainHomeWorkspace({ workspaceType: "project" })).toBe(true);
    expect(
      isDomainHomeWorkspace({
        workspaceType: "personal",
        settings: { surfaceClass: "domain" },
      })
    ).toBe(true);
  });

  it("does not gate on display name — name is not a signal", () => {
    // Product invariant: never hardcode workspace NAME. Even a workspace
    // whose name looks like an admin console stays routable without metadata.
    // Cast: WorkspaceHomeSignals only types surfaceClass/systemSlug; extra
    // keys (templateName, display name, …) are ignored at runtime.
    expect(
      isDomainHomeWorkspace({
        workspaceType: "personal",
        settings: { templateName: "anything" } as {
          surfaceClass?: string | null;
          systemSlug?: string | null;
        },
      })
    ).toBe(true);
  });
});
