import { describe, expect, it } from "vitest";
import {
  mergeWorkspacePrimarySurface,
  resolveWorkspacePrimarySurface,
} from "./workspace-primary-surface.js";

const dashboard = {
  kind: "app" as const,
  appId: "dashboard",
  rendererType: "native" as const,
};

describe("mergeWorkspacePrimarySurface", () => {
  it("preserves the live surface when the directive is absent", () => {
    const live = { primarySurface: dashboard, theme: "dark" };
    expect(mergeWorkspacePrimarySurface(live, { theme: "light" })).toEqual({
      layout: live,
      changed: false,
    });
  });

  it("replaces the live surface without losing other layout fields", () => {
    const crm = {
      kind: "app" as const,
      appId: "crm",
      rendererType: "external" as const,
      url: "https://crm.synap.live",
    };
    expect(
      mergeWorkspacePrimarySurface(
        { primarySurface: dashboard, theme: "dark" },
        { primarySurface: crm }
      )
    ).toEqual({
      layout: { primarySurface: crm, theme: "dark" },
      changed: true,
    });
  });

  it("clears to workspace home and is idempotent", () => {
    expect(
      mergeWorkspacePrimarySurface(
        { primarySurface: dashboard, pinnedApps: ["data"] },
        { primarySurface: null }
      )
    ).toEqual({
      layout: { primarySurface: null, pinnedApps: ["data"] },
      changed: true,
    });
    expect(
      mergeWorkspacePrimarySurface(
        { primarySurface: null, pinnedApps: ["data"] },
        { primarySurface: null }
      ).changed
    ).toBe(false);
  });

  it("uses structural equality independent of object key order", () => {
    const reordered = {
      rendererType: "native" as const,
      appId: "dashboard",
      kind: "app" as const,
    };
    expect(
      mergeWorkspacePrimarySurface(
        { primarySurface: dashboard },
        { primarySurface: reordered }
      ).changed
    ).toBe(false);
  });
});

describe("resolveWorkspacePrimarySurface", () => {
  const candidates = [
    { id: "view-pipeline", name: "Pipeline", slug: "pipeline" },
    { id: "view-accounts", name: "Accounts", slug: "accounts" },
  ];

  it("resolves an authored view name or slug to a persisted viewId", () => {
    expect(
      resolveWorkspacePrimarySurface(
        { kind: "view", viewName: "Pipeline" },
        candidates
      )
    ).toEqual({ kind: "view", viewId: "view-pipeline" });
    expect(
      resolveWorkspacePrimarySurface(
        { kind: "view", viewSlug: "accounts", title: "Customers" },
        candidates
      )
    ).toEqual({
      kind: "view",
      viewId: "view-accounts",
      title: "Customers",
    });
  });

  it("leaves persisted and non-view descriptors unchanged", () => {
    expect(
      resolveWorkspacePrimarySurface(
        { kind: "view", viewId: "view-existing" },
        candidates
      )
    ).toEqual({ kind: "view", viewId: "view-existing" });
    expect(resolveWorkspacePrimarySurface(dashboard, candidates)).toBe(
      dashboard
    );
  });

  it("fails when an authored view cannot be resolved", () => {
    expect(() =>
      resolveWorkspacePrimarySurface(
        { kind: "view", viewName: "Missing" },
        candidates
      )
    ).toThrow(/did not match/);
  });

  it("fails rather than choosing an ambiguous view", () => {
    expect(() =>
      resolveWorkspacePrimarySurface({ kind: "view", viewName: "Pipeline" }, [
        ...candidates,
        { id: "view-pipeline-2", name: "Pipeline", slug: "pipeline-2" },
      ])
    ).toThrow(/ambiguous/);
  });
});
