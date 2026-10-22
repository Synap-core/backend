import { afterEach, describe, expect, it } from "vitest";
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

/**
 * A space linked to a pod app (spec 17 §7.1, PB7): the url surface carries the
 * app's CIMD client_id as a LAUNCH HINT. It grants nothing, so the only thing
 * this door must hold is the shape: the same client_id URL rules as /authorize,
 * on a url surface only, and nothing else riding along.
 */
describe("workspacePrimarySurfaceSchema podApp (spec 17 PB7)", () => {
  const CLIENT_ID = "https://studio.example.com/.well-known/synap-client.json";
  const site = (clientId: unknown, extra: Record<string, unknown> = {}) => ({
    kind: "url",
    url: "https://studio.example.com/",
    title: "Content Studio",
    podApp: { clientId, ...extra },
  });
  const previousPublicUrl = process.env.PUBLIC_URL;
  afterEach(() => {
    if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = previousPublicUrl;
  });

  it("accepts a url surface linked to a pod app, at both doors", () => {
    expect(workspacePrimarySurfaceSchema.parse(site(CLIENT_ID))).toEqual(
      site(CLIENT_ID)
    );
    expect(workspaceRuntimePrimarySurfaceSchema.parse(site(CLIENT_ID))).toEqual(
      site(CLIENT_ID)
    );
  });

  it("keeps a plain url surface valid (podApp is optional)", () => {
    expect(
      workspaceRuntimePrimarySurfaceSchema.parse({
        kind: "url",
        url: "https://example.com",
      })
    ).toEqual({ kind: "url", url: "https://example.com" });
  });

  it("allows podApp on a url surface only", () => {
    const podApp = { clientId: CLIENT_ID };
    for (const surface of [
      { kind: "app", appId: "crm", rendererType: "native", podApp },
      {
        kind: "app",
        appId: "crm",
        rendererType: "external",
        url: "https://crm.synap.live",
        podApp,
      },
      { kind: "cell", cellKey: "note", podApp },
      { kind: "view", viewId: "view-1", podApp },
    ]) {
      expect(() => workspacePrimarySurfaceSchema.parse(surface)).toThrow();
    }
  });

  it("carries a client_id and nothing else (no token, no secret)", () => {
    expect(() =>
      workspacePrimarySurfaceSchema.parse(
        site(CLIENT_ID, { accessToken: "synap_hub_x" })
      )
    ).toThrow();
    expect(() =>
      workspacePrimarySurfaceSchema.parse({
        kind: "url",
        url: "https://studio.example.com/",
        podApp: {},
      })
    ).toThrow();
    expect(() => workspacePrimarySurfaceSchema.parse(site(42))).toThrow();
  });

  it.each([
    ["studio.example.com/client.json", "not an absolute URL"],
    ["http://studio.example.com/client.json", "must use https"],
    [
      "https://user:pw@studio.example.com/client.json",
      "must not contain credentials",
    ],
    ["https://studio.example.com/client.json?v=1", "must not contain a query"],
    ["https://studio.example.com/client.json#x", "must not contain a fragment"],
    ["https://studio.example.com/a/../client.json", "path segments"],
    ["https://studio.example.com/", "must have a path"],
    ["https://Studio.example.com/client.json", "not in canonical form"],
    ["https://203.0.113.7/client.json", "must use a domain name"],
    [`https://studio.example.com/${"a".repeat(512)}`, "longer than 512"],
  ])("refuses the client_id %s (%s)", (clientId, reason) => {
    expect(() => workspacePrimarySurfaceSchema.parse(site(clientId))).toThrow(
      reason
    );
  });

  it("refuses a client_id on this pod's own origin", () => {
    process.env.PUBLIC_URL = "https://pod.example.com";
    expect(() =>
      workspacePrimarySurfaceSchema.parse(
        site("https://pod.example.com/.well-known/synap-client.json")
      )
    ).toThrow("must not be on this pod");
  });
});
