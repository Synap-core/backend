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
      expect(await res.text()).toBe(SYNAP_MARK_SVG);
    }
  );

  it("sends nothing off the pod: no redirect to another host", async () => {
    const app = makeApp();
    for (const path of ["/icon.png", "/apple-touch-icon.png"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    }
  });
});
