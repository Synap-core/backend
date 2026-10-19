import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { renderSetupPage } from "./setup-page.js";

// /setup is public on every pod host (the TLS edge forwards every route since
// 2026-10-19). It reflected ?token= into an inline <script>: a reflected XSS.
describe("renderSetupPage", () => {
  it("reads the token from its own URL instead of taking it from the server", () => {
    const html = renderSetupPage(true);
    expect(html).toContain("new URLSearchParams(location.search).get('token')");
    expect(html).toContain('id="form"');
  });

  it("cannot reflect a token: the renderer is never given one", () => {
    // The route passes only a boolean; prove the shipped route still does.
    const route = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const line = route.split("\n").find((l) => l.includes("renderSetupPage("));
    expect(
      line,
      "the /setup route no longer calls renderSetupPage"
    ).toBeDefined();
    expect(line).toMatch(
      /renderSetupPage\(Boolean\(c\.req\.query\("token"\)\)\)/
    );
    expect(renderSetupPage.length).toBe(1);
  });

  it("without a token shows no form", () => {
    expect(renderSetupPage(false)).not.toContain('id="form"');
  });
});
