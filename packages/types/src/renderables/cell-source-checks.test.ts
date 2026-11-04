import { describe, expect, it } from "vitest";
import {
  checkCellSource,
  formatCellSourceRefusal,
  HOST_PROVIDED_FRAME_SPECIFIERS,
} from "./cell-source-checks.js";

const codes = (r: { code: string }[]) => r.map((f) => f.code);

/** A frame cell the way `synap cell build` emits one: host modules only. */
const GOOD_FRAME = [
  'import { useState } from "react";',
  'import { jsx } from "react/jsx-runtime";',
  'import { SpatialButton, resolveObjectNoun } from "@synap/kit";',
  'const SVG = "http://www.w3.org/2000/svg";',
  "export default function Cell() {",
  "  const [n] = useState(0);",
  '  return jsx("svg", { xmlns: SVG, children: n });',
  "}",
].join("\n");

/** The minified form a bundler writes: no spaces around the specifier. */
const MINIFIED_FRAME =
  'import{useState as a}from"react";import*as k from"@synap/kit";export default function C(){return a(0),null}';

describe("checkCellSource: a frame cell that mounts is not refused", () => {
  it.each([
    ["a built cell", GOOD_FRAME],
    ["a minified bundle", MINIFIED_FRAME],
    [
      "a data: import",
      'import x from "data:text/javascript,export default 1";\nexport default () => null;',
    ],
  ])("%s", (_label, source) => {
    expect(checkCellSource({ source, mechanism: "frame" }).refusals).toEqual(
      []
    );
  });

  it("deps naming only host modules are ignored, as the frame ignores them", () => {
    const deps = Object.fromEntries(
      HOST_PROVIDED_FRAME_SPECIFIERS.map((s) => [s, "*"])
    );
    expect(
      checkCellSource({ source: GOOD_FRAME, mechanism: "frame", deps }).refusals
    ).toEqual([]);
  });

  it("a request to an origin the package declared is allowed", () => {
    const source =
      'export default () => { fetch("https://api.vendor.com/v1/x"); return null; };';
    expect(
      checkCellSource({
        source,
        mechanism: "frame",
        externalHosts: ["https://api.vendor.com"],
      }).refusals
    ).toEqual([]);
    // A declared wss origin opens the WebSocket, and an https origin opens
    // the wss one too (CSP matches `https://x` for `wss://x`).
    const live =
      'export default () => { new WebSocket("wss://live.vendor.com/s"); return null; };';
    for (const host of ["wss://live.vendor.com", "https://live.vendor.com"]) {
      expect(
        checkCellSource({
          source: live,
          mechanism: "frame",
          externalHosts: [host],
        }).refusals
      ).toEqual([]);
    }
  });

  it("a host the frame drops is refused, and opens nothing: no scheme, a path, a wildcard", () => {
    // One host rule (`frameExternalOrigins`, the parse of ViewFrame
    // `buildFrameCsp`): an http(s)/ws(s) origin only. The host itself is
    // refused (`external_host`), and a request to it too: it is blocked at
    // run time.
    const source =
      'export default () => { fetch("https://api.vendor.com/v1/x"); return null; };';
    for (const host of [
      "api.vendor.com",
      "https://api.vendor.com/v1",
      "https://*.vendor.com",
      "https://user:pw@api.vendor.com",
    ]) {
      expect(
        codes(
          checkCellSource({ source, mechanism: "frame", externalHosts: [host] })
            .refusals
        )
      ).toEqual(["external_host", "network_request"]);
    }
  });

  it("a blank host entry declares nothing, and a padded origin is that origin", () => {
    const source =
      'export default () => { fetch("https://api.vendor.com/v1/x"); return null; };';
    expect(
      checkCellSource({
        source,
        mechanism: "frame",
        externalHosts: [" https://api.vendor.com ", "", "  "],
      }).refusals
    ).toEqual([]);
  });

  it("the host refusal names the host and the fix", () => {
    const r = checkCellSource({
      source: "export default () => null;",
      mechanism: "frame",
      externalHosts: ["api.vendor.com"],
    }).refusals;
    expect(codes(r)).toEqual(["external_host"]);
    expect(r[0]!.line).toBeNull();
    expect(r[0]!.message).toContain("api.vendor.com");
    expect(r[0]!.fix).toContain("https://api.vendor.com");
  });

  it("an import in a comment that opens its line is not an import", () => {
    const source =
      '// import x from "https://esm.sh/x";\n/*\nimport y from "d3";\n*/\nexport default () => null;';
    expect(
      codes(checkCellSource({ source, mechanism: "frame" }).refusals)
    ).toEqual(["esm_sh"]);
  });
});

describe("checkCellSource: what cannot mount in a frame is refused, with its line", () => {
  it("runtime deps the host does not provide", () => {
    const r = checkCellSource({
      source: GOOD_FRAME,
      mechanism: "frame",
      deps: { recharts: "2.12.0", react: "19" },
    }).refusals;
    expect(codes(r)).toEqual(["runtime_deps"]);
    expect(r[0]!.message).toContain("recharts");
    expect(r[0]!.message).not.toContain("react,");
    expect(r[0]!.fix).toContain("--bundle-deps");
  });

  it.each([
    ['import { LineChart } from "recharts";', "unprovided_import", 1],
    ['\n\nimport * as d3 from "d3";', "unprovided_import", 3],
    ['import x from "./helpers.js";', "local_import", 1],
    ['import x from "/assets/x.js";', "local_import", 1],
    ['import x from "https://cdn.jsdelivr.net/npm/x";', "network_import", 1],
    ['import x from "//unpkg.com/x";', "network_import", 1],
    ['const m = await import("https://esm.sh/three");', "network_import", 1],
    ['export { a } from "lodash";', "unprovided_import", 1],
  ])("%s → %s on line %i", (line, code, at) => {
    const r = checkCellSource({
      source: `${line}\nexport default () => null;`,
      mechanism: "frame",
    }).refusals;
    expect(codes(r)).toEqual([code]);
    expect(r[0]!.line).toBe(at);
    expect(r[0]!.message).toContain(`Line ${at}`);
  });

  it("esm.sh named anywhere, as the web frame refuses it at mount", () => {
    const r = checkCellSource({
      source: 'const base = "https://esm.sh/";\nexport default () => null;',
      mechanism: "frame",
    }).refusals;
    expect(codes(r)).toEqual(["esm_sh"]);
  });

  it("a request to an origin the frame may not reach", () => {
    const r = checkCellSource({
      source:
        'export default () => {\n  fetch("https://api.other.com/x");\n  new WebSocket("wss://live.other.com");\n  return null;\n};',
      mechanism: "frame",
      externalHosts: ["https://api.vendor.com"],
    }).refusals;
    expect(codes(r)).toEqual(["network_request", "network_request"]);
    expect(r.map((f) => f.line)).toEqual([2, 3]);
  });

  it("a CSS @import of a remote sheet", () => {
    const r = checkCellSource({
      source:
        'const css = `@import url("https://fonts.googleapis.com/css2?family=Inter");`;\nexport default () => null;',
      mechanism: "frame",
    }).refusals;
    expect(codes(r)).toEqual(["network_stylesheet"]);
  });
});

describe("checkCellSource: an HTML page gets no host modules and no network", () => {
  const page = (body: string) =>
    `<!doctype html>\n<html><head>\n${body}\n</head><body></body></html>`;

  it("inline script and inline style mount", () => {
    const r = checkCellSource({
      source: page(
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n<style>body{margin:0}</style>\n<script>SynapWidget.onInit(() => {});</script>\n<!-- <script src="https://cdn.x/y.js"></script> -->'
      ),
      mechanism: "iframe",
    });
    expect(r.refusals).toEqual([]);
  });

  it.each([
    [
      '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
      "network_script",
    ],
    ['<script type="module" src="./app.js"></script>', "network_script"],
    [
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      "network_stylesheet",
    ],
    [
      '<script type="module">\nimport { createRoot } from "react-dom/client";\n</script>',
      "page_import",
    ],
    [
      '<script type="module">import x from "https://esm.sh/x";</script>',
      "network_import",
    ],
    ['<script>fetch("https://api.vendor.com/x")</script>', "network_request"],
  ])("%s → %s", (tag, code) => {
    const r = checkCellSource({ source: page(tag), mechanism: "iframe" });
    expect(codes(r.refusals)).toEqual([code]);
    expect(r.refusals[0]!.line).toBeGreaterThanOrEqual(3);
  });

  it("a page reaches no origin, even one listed in externalHosts", () => {
    const r = checkCellSource({
      source: page('<script>fetch("https://api.vendor.com/x")</script>'),
      mechanism: "iframe",
      externalHosts: ["https://api.vendor.com"],
    });
    expect(codes(r.refusals)).toEqual(["network_request"]);
  });
});

describe("checkCellSource: advice is never a refusal", () => {
  it("raw colours, images with no alt, clickable divs", () => {
    const r = checkCellSource({
      source:
        '<div style="color:#ff0000">\n<img src="data:image/png;base64,AA">\n<div onclick="go()">x</div>\n<span style="background: #fff"></span>',
      mechanism: "iframe",
    });
    expect(r.refusals).toEqual([]);
    expect(codes(r.advice)).toEqual([
      "raw_colour",
      "image_without_alt",
      "click_without_button",
    ]);
    expect(r.advice[0]!.message).toContain("2 hard-coded colours");
    expect(r.advice[0]!.line).toBe(1);
  });

  it("tokens, alt text and buttons give no advice", () => {
    const r = checkCellSource({
      source:
        'export default () => <button onClick={go} style={{ color: "var(--synap-primary)" }}><img alt="" src="data:,"/></button>;',
      mechanism: "frame",
    });
    expect(r.advice).toEqual([]);
  });
});

describe("formatCellSourceRefusal", () => {
  it("names each reason and each fix once", () => {
    const { refusals } = checkCellSource({
      source:
        'import a from "d3";\nimport b from "recharts";\nexport default () => null;',
      mechanism: "frame",
    });
    const text = formatCellSourceRefusal(refusals);
    expect(text).toContain('Line 1 imports "d3"');
    expect(text).toContain('Line 2 imports "recharts"');
    expect(text.match(/--bundle-deps/g)).toHaveLength(1);
  });

  it("lists the first 20 reasons and counts the rest", () => {
    const source = Array.from(
      { length: 25 },
      (_, i) => `import x${i} from "lib${i}";`
    ).join("\n");
    const { refusals } = checkCellSource({ source, mechanism: "frame" });
    expect(refusals).toHaveLength(25);
    const text = formatCellSourceRefusal(refusals);
    expect(text).toContain('Line 20 imports "lib19"');
    expect(text).not.toContain("Line 21 imports");
    expect(text).toContain("…and 5 more.");
  });
});
