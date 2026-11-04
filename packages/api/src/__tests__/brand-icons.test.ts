/**
 * A pod's host serves the current Synap mark (brand-icons.ts),
 * so an MCP client or favicon service that draws a pod connector by its host
 * finds the amber S, not a stale cached logo.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { brandIconsApp, SYNAP_MARK_SVG } from "../brand-icons.js";

function makeApp() {
  const app = new Hono();
  app.route("/", brandIconsApp);
  return app;
}

/** The six stops of the mark's radial gradient, dark pinch to bright tips. */
const GRADIENT = [
  "#c35100",
  "#db6500",
  "#eb8105",
  "#fa9d09",
  "#fcbd16",
  "#ffdb23",
];

describe("brand icons on the pod host", () => {
  it("/favicon.ico is an ICO file", async () => {
    const res = await makeApp().request("/favicon.ico");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/x-icon");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // ICONDIR: reserved 0, type 1 (icon), at least one image.
    expect([...bytes.slice(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(bytes[4]).toBeGreaterThan(0);
  });

  it.each(["/favicon.svg", "/icon.svg"])(
    "%s is the amber S with its gradient",
    async (path) => {
      const res = await makeApp().request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
      expect(res.headers.get("content-security-policy")).toContain(
        "default-src 'none'"
      );
      const svg = await res.text();
      expect(svg).toBe(SYNAP_MARK_SVG);
      expect(svg).toContain('viewBox="0 0 724 1584"');
      for (const stop of GRADIENT)
        expect(svg).toContain(`stop-color="${stop}"`);
      expect(svg).not.toMatch(/<script/i);
    }
  );

  it("raster sizes redirect to the website's copies", async () => {
    const app = makeApp();
    const icon = await app.request("/icon.png");
    expect(icon.status).toBe(301);
    expect(icon.headers.get("location")).toBe(
      "https://www.synap.live/icon.png"
    );
    const apple = await app.request("/apple-touch-icon.png");
    expect(apple.status).toBe(301);
    expect(apple.headers.get("location")).toBe(
      "https://www.synap.live/apple-icon.png"
    );
  });
});
