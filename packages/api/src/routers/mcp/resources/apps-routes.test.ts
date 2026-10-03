import { afterEach, describe, expect, it } from "vitest";

/**
 * Tests for the MCP Apps surface RESTored routes (ui://synap/<kind>/<id>).
 *
 * These verify that:
 * 1. The MCP resource HTML references the correct absolute URL (not relative)
 * 2. The CSP on the HTML is secure
 * 3. The resources.list/read functions work correctly
 */

describe("MCP Apps surface resources", () => {
  afterEach(() => {
    // Reset env between tests
    delete process.env.PUBLIC_URL;
  });

  describe("resources.list() returns UI templates", async () => {
    it("returns templates for all five kinds", async () => {
      const { resources } = await import("./index.js");
      const list = await resources.list();

      const uiResources = list.filter((r) => r.uri.startsWith("ui://synap/"));
      expect(uiResources.length).toBe(5);

      const kinds = uiResources.map((r) => r.uri.match(/ui:\/\/synap\/(\w+)\/\*/)?.[1]).sort();
      expect(kinds).toEqual(["channel", "entity", "proposal", "session", "view"]);
    });
  });

  describe("resources.read() for UI resources", async () => {
    it("reads a ui://synap/entity/<id> resource with absolute URL", async () => {
      process.env.PUBLIC_URL = "http://localhost:4000";
      const { resources } = await import("./index.js");
      const result = await resources.read(
        "ui://synap/entity/abc123",
        "user-id",
        ["mcp.read"]
      );

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe("ui://synap/entity/abc123");
      expect(result.contents[0].mimeType).toContain("text/html");
      expect(result.contents[0].text).toContain("Loading Synap entity...");
      // Verify ABSOLUTE URL is used
      expect(result.contents[0].text).toContain(
        `src="http://localhost:4000/apps/entity/abc123?embed=1"`
      );
      // Verify no relative path
      expect(result.contents[0].text).not.toContain('src="/apps/');
    });

    it("includes a secure CSP in the generated HTML", async () => {
      process.env.PUBLIC_URL = "http://localhost:4000";
      const { resources } = await import("./index.js");
      const result = await resources.read(
        "ui://synap/entity/test-uuid",
        "user-id",
        ["mcp.read"]
      );

      const html = result.contents[0].text!;
      expect(html).toContain("default-src 'none'");
      expect(html).toContain("script-src 'self'");
      expect(html).toContain("style-src 'self' 'unsafe-inline'");
      expect(html).toContain("img-src data: blob: https:");
      expect(html).toContain("font-src data: https:");
      expect(html).toContain("connect-src 'self'");
      expect(html).toContain("frame-ancestors 'self'");
      expect(html).toContain("object-src 'none'");
    });

    it("uses a secure sandbox attribute", async () => {
      process.env.PUBLIC_URL = "http://localhost:4000";
      const { resources } = await import("./index.js");
      const result = await resources.read(
        "ui://synap/view/test-uuid",
        "user-id",
        ["mcp.read"]
      );

      const html = result.contents[0].text!;
      // allow-scripts allow-same-origin is standard for authenticated iframes
      expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
      expect(html).toContain('allow="synap-widget"');
    });

    it("falls back to default URL when PUBLIC_URL is not set", async () => {
      delete process.env.PUBLIC_URL;
      const { resources } = await import("./index.js");
      const result = await resources.read(
        "ui://synap/entity/test-uuid",
        "user-id",
        ["mcp.read"]
      );

      const html = result.contents[0].text!;
      expect(html).toContain(
        `src="http://localhost:4000/apps/entity/test-uuid?embed=1"`
      );
    });

    it("returns HTML for all five valid kinds", async () => {
      process.env.PUBLIC_URL = "http://localhost:4000";
      const { resources } = await import("./index.js");

      for (const kind of ["entity", "view", "proposal", "session", "channel"] as const) {
        const result = await resources.read(
          `ui://synap/${kind}/test-uuid`,
          "user-id",
          ["mcp.read"]
        );

        const html = result.contents[0].text!;
        expect(html).toContain(`Loading Synap ${kind}...`);
        expect(html).toContain(`/apps/${kind}/test-uuid?embed=1`);
      }
    });
  });
});