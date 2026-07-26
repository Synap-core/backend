import { describe, expect, it } from "vitest";
import {
  workspacePrimarySurfaceSchema,
  workspaceRuntimePrimarySurfaceSchema,
} from "./workspace-primary-surface.js";

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

  it("accepts an ordinary website without granting it an app identity", () => {
    expect(
      workspacePrimarySurfaceSchema.parse({
        kind: "url",
        url: "https://example.com/dashboard",
        title: "Dashboard",
      })
    ).toEqual({
      kind: "url",
      url: "https://example.com/dashboard",
      title: "Dashboard",
    });
  });

  it("rejects non-web URL schemes", () => {
    expect(() =>
      workspacePrimarySurfaceSchema.parse({
        kind: "url",
        url: "javascript:alert(1)",
      })
    ).toThrow();
  });

  it("rejects credentials embedded in ordinary and hosted URLs", () => {
    expect(() =>
      workspacePrimarySurfaceSchema.parse({
        kind: "url",
        url: "https://user:secret@example.com/dashboard",
      })
    ).toThrow("must not include credentials");
    expect(() =>
      workspacePrimarySurfaceSchema.parse({
        kind: "app",
        appId: "crm",
        rendererType: "external",
        url: "https://user:secret@crm.synap.live",
      })
    ).toThrow("must not include credentials");
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

  it("requires a resolved view id at the persistence door", () => {
    expect(() =>
      workspaceRuntimePrimarySurfaceSchema.parse({
        kind: "view",
        viewName: "Pipeline",
        viewSlug: "pipeline",
      })
    ).toThrow("requires a viewId");
    expect(
      workspaceRuntimePrimarySurfaceSchema.parse({
        kind: "view",
        viewId: "view-123",
      })
    ).toEqual({ kind: "view", viewId: "view-123" });
  });
});
