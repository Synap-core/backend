import { describe, expect, it } from "vitest";
import {
  frameNetworkAssetsNotice,
  frameNetworkCodeRefusal,
  frameNetworkLoads,
} from "./index.js";

describe("frameNetworkLoads: what a stored page asks the network for", () => {
  it("a self-contained page loads nothing", () => {
    const page =
      "<!doctype html><html><head><style>body{font:14px system-ui}</style></head>" +
      "<body><img src=\"data:image/png;base64,AAAA\"><script>window.synap.query('entities.list')</script></body></html>";
    expect(frameNetworkLoads(page)).toEqual({ code: [], assets: [] });
    expect(frameNetworkCodeRefusal(page)).toBeNull();
    expect(frameNetworkAssetsNotice(page)).toBeNull();
  });

  it("a CDN script is code, by its host (protocol-relative too)", () => {
    const page =
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>' +
      "<script src=//unpkg.com/d3@7 defer></script>" +
      "<script type='module' src='https://cdnjs.cloudflare.com/x.js'></script>";
    expect(frameNetworkLoads(page).code).toEqual([
      "cdn.jsdelivr.net",
      "cdnjs.cloudflare.com",
      "unpkg.com",
    ]);
  });

  it("module imports from a URL inside a script are code; the same words in prose are not", () => {
    const page =
      '<p>We import from "https://example.org/data" every week.</p>' +
      '<script type="module">\n' +
      "import * as d3 from 'https://esm.sh/d3@7';\n" +
      "import 'https://ga.jspm.io/npm:lit@3';\n" +
      'const m = await import("https://cdn.skypack.dev/three");\n' +
      "export { x } from 'https://esm.run/x';\n" +
      "</script>";
    expect(frameNetworkLoads(page).code).toEqual([
      "cdn.skypack.dev",
      "esm.run",
      "esm.sh",
      "ga.jspm.io",
    ]);
  });

  it("an import map's URLs are code", () => {
    const page =
      '<script type="importmap">{"imports":{"react":"https://esm.sh/react@19"}}</script>' +
      "<script type=module>import React from 'react'</script>";
    expect(frameNetworkLoads(page).code).toEqual(["esm.sh"]);
  });

  it("a modulepreload link is code; a stylesheet, a CSS import, a font url or an image is an asset", () => {
    const page =
      '<link rel="modulepreload" href="https://esm.sh/react@19">' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' +
      "<style>@import url('https://cdn.example.com/base.css'); @font-face{src:url(https://fonts.gstatic.com/x.woff2)}</style>" +
      '<img src="https://images.example.com/a.png">';
    expect(frameNetworkLoads(page)).toEqual({
      code: ["esm.sh"],
      assets: [
        "cdn.example.com",
        "fonts.googleapis.com",
        "fonts.gstatic.com",
        "images.example.com",
      ],
    });
  });

  it("hint links load nothing, and a commented-out tag loads nothing", () => {
    const page =
      '<link rel="preconnect" href="https://fonts.googleapis.com">' +
      '<link rel="dns-prefetch" href="//cdn.jsdelivr.net">' +
      '<!-- <script src="https://cdn.jsdelivr.net/npm/old"></script> -->';
    expect(frameNetworkLoads(page)).toEqual({ code: [], assets: [] });
  });
});

describe("the sentences the author and the reader read", () => {
  it("a page with network code is refused, naming every host", () => {
    const refusal = frameNetworkCodeRefusal(
      '<script src="https://cdn.jsdelivr.net/a"></script><script src="https://unpkg.com/b"></script>'
    );
    expect(refusal).toBe(
      "This page loads code from cdn.jsdelivr.net and unpkg.com. Pages run with no network, so that code never loads and the page does not run."
    );
  });

  it("a page with only web fonts is not refused: it runs and draws without them", () => {
    const page =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><p>Hi</p>';
    expect(frameNetworkCodeRefusal(page)).toBeNull();
    expect(frameNetworkAssetsNotice(page)).toBe(
      "This page loads styles, fonts or images from fonts.googleapis.com. Pages run with no network, so it draws without them."
    );
  });

  it("never names a banned failure phrase", () => {
    const words = [
      frameNetworkCodeRefusal('<script src="https://x.example/a"></script>'),
      frameNetworkAssetsNotice('<img src="https://x.example/a.png">'),
    ].join(" ");
    expect(words).not.toMatch(/\b(oops|sorry|something went wrong)\b/i);
  });
});

describe("the scan is linear in the page (it runs on the pod's request thread)", () => {
  // Before the rewrite, 1 MB of `<script ` took 164 s and 1 MB of `import `
  // inside a script 136 s (backtracking over unbounded spans): at 200 000
  // characters that is still seconds per page. Linear, each takes milliseconds.
  const N = 200_000;
  const pages: Record<string, string> = {
    "many unclosed script tags": "<script ".repeat(N / 8),
    "a script full of import keywords":
      "<script>" + "import ".repeat(N / 7) + "</script>",
    "an attribute followed by spaces": "<script src=" + " ".repeat(N) + ">",
    "an unclosed CSS url(": "<style>url(" + " ".repeat(N),
    "an export clause with no from":
      "<script>" + "export a b c ".repeat(N / 13) + "</script>",
  };
  for (const [what, page] of Object.entries(pages)) {
    it(`${what}: under a second`, () => {
      const t = performance.now();
      frameNetworkLoads(page);
      expect(performance.now() - t).toBeLessThan(1000);
    });
  }
});
