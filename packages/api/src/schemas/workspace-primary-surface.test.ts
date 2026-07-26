import { describe, expect, it } from "vitest";
import { workspacePrimarySurfaceSchema } from "./workspace-primary-surface.js";

describe("workspacePrimarySurfaceSchema", () => {
  it("accepts the hosted application contract", () => {
    expect(
      workspacePrimarySurfaceSchema.parse({
        kind: "app",
        appId: "crm",
        rendererType: "external",
        url: "https://crm.synap.live",
        props: { compact: true, filters: ["active", null] },
      })
    ).toMatchObject({ appId: "crm", rendererType: "external" });
  });

  it("rejects an external URL without an application identity", () => {
    expect(() =>
      workspacePrimarySurfaceSchema.parse({
        kind: "app",
        rendererType: "external",
        url: "https://crm.synap.live",
      })
    ).toThrow();
  });

  it("rejects persisted runtime lens context", () => {
    expect(() =>
      workspacePrimarySurfaceSchema.parse({
        kind: "app",
        appId: "crm",
        rendererType: "external",
        url: "https://crm.synap.live",
        workspaceId: "must-be-injected-at-runtime",
      })
    ).toThrow();
  });

  it("accepts authoring-time view names and slugs", () => {
    expect(
      workspacePrimarySurfaceSchema.parse({
        kind: "view",
        viewName: "Pipeline",
        viewSlug: "pipeline",
      })
    ).toEqual({
      kind: "view",
      viewName: "Pipeline",
      viewSlug: "pipeline",
    });
  });
});
