/**
 * The module frame's srcdoc (`buildCellModuleFrameSrcdoc`): what every host
 * of a module cell embeds, built once. Its order is its security: the policy
 * first, then the host's modules as data, then the classic scripts, then the
 * module. Nothing loads from the network.
 */
import { describe, expect, it } from "vitest";
import {
  CELL_FRAME_MOUNT_TIMEOUT_MS,
  CELL_FRAME_READY_TIMEOUT_MS,
  CELL_MODULE_FRAME_SANDBOX,
  FRAME_BLOB_URLS_SCRIPT,
  FRAME_IMPORT_MAP_SCRIPT,
  FRAME_INIT_QUEUE_SCRIPT,
  SYNAP_VIEW_SDK,
  SYNAP_WIDGET_SDK,
  buildCellModuleFrameCsp,
  buildCellModuleFrameSrcdoc,
  cellModuleHostModulesRefusal,
  cellModuleNeedsJsxDev,
  cellModuleNeedsKit,
  cellModuleNetworkRefusal,
  frameEsmShAt,
  utf8ToBase64,
  type CellFrameHostModules,
} from "./index.js";

const MODULES: CellFrameHostModules = {
  react: "export default 'react';",
  reactDom: "export default 'react-dom';",
  reactDomClient: "export const createRoot = () => null;",
  jsxRuntime: "export const jsx = () => null;",
  jsxDevRuntime: "export const jsxDEV = () => null;",
  kit: "export const Card = () => null;",
  tokensCss: ":root { --synap-color: #111; }",
};
const CELL = "export default function Cell() { return null; }";

/** The base64 JSON payload the frame decodes, as module name → source. */
function payload(srcdoc: string): Record<string, string> {
  const m = srcdoc.match(
    /<script type="application\/json" id="synap-frame-modules">([^<]*)<\/script>/
  );
  expect(m, "the modules payload").not.toBeNull();
  const raw = JSON.parse(m![1]!) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(raw).map(([k, b64]) => [
      k,
      Buffer.from(b64, "base64").toString("utf8"),
    ])
  );
}

function headOf(srcdoc: string): string {
  return srcdoc.slice(srcdoc.indexOf("<head>"), srcdoc.indexOf("</head>"));
}

describe("the module frame", () => {
  it("is sandboxed to scripts and dialogs: never same-origin, never popups", () => {
    expect(CELL_MODULE_FRAME_SANDBOX).toBe("allow-scripts allow-modals");
    expect(CELL_MODULE_FRAME_SANDBOX).not.toMatch(/same-origin|popups|top/);
    expect(CELL_FRAME_READY_TIMEOUT_MS).toBe(5_000);
    expect(CELL_FRAME_MOUNT_TIMEOUT_MS).toBe(15_000);
  });

  it("writes the policy as the FIRST element of the head", () => {
    const srcdoc = buildCellModuleFrameSrcdoc({
      code: CELL,
      language: "react",
      theme: "dark",
      hostModules: MODULES,
    });
    const head = headOf(srcdoc);
    const first = head.slice("<head>".length).trim().split("\n")[0];
    expect(first).toBe(
      `<meta http-equiv="Content-Security-Policy" content="${buildCellModuleFrameCsp()}">`
    );
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(
      srcdoc.indexOf("<script")
    );
    expect(srcdoc.indexOf("Content-Security-Policy")).toBeLessThan(
      srcdoc.indexOf("<style")
    );
  });

  it("approved hosts reach connect and img only, through the one policy", () => {
    const srcdoc = buildCellModuleFrameSrcdoc({
      code: CELL,
      language: "module",
      theme: "light",
      externalHosts: ["https://api.example.com"],
      hostModules: { tokensCss: "" },
    });
    expect(srcdoc).toContain(
      buildCellModuleFrameCsp(["https://api.example.com"])
    );
  });

  it("runs the classic scripts in order: blob URLs, import map, SDKs, ready + init queue, then the module", () => {
    const srcdoc = buildCellModuleFrameSrcdoc({
      code: CELL,
      language: "react",
      theme: "light",
      hostModules: MODULES,
    });
    const at = [
      srcdoc.indexOf('id="synap-frame-modules"'),
      srcdoc.indexOf(FRAME_BLOB_URLS_SCRIPT),
      srcdoc.indexOf(FRAME_IMPORT_MAP_SCRIPT),
      srcdoc.indexOf(SYNAP_WIDGET_SDK),
      srcdoc.indexOf(SYNAP_VIEW_SDK),
      srcdoc.indexOf(FRAME_INIT_QUEUE_SCRIPT),
      srcdoc.indexOf('<script type="module">'),
    ];
    for (const i of at) expect(i).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("loads nothing from the network: no src, no link, no stylesheet import, no esm.sh", () => {
    const srcdoc = buildCellModuleFrameSrcdoc({
      code: CELL,
      language: "react",
      theme: "light",
      hostModules: MODULES,
    });
    expect(srcdoc).not.toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(srcdoc).not.toMatch(/<link\b/i);
    expect(srcdoc).not.toMatch(/@import\s/);
    expect(frameEsmShAt(srcdoc)).toBe(-1);
    // The modules are data the frame turns into blob: URLs itself.
    expect(FRAME_BLOB_URLS_SCRIPT).toContain("URL.createObjectURL(new Blob(");
    expect(FRAME_IMPORT_MAP_SCRIPT).toContain("tag.type = 'importmap'");
  });

  it("a react frame embeds React and its DOM; the dev runtime and the kit only when its code imports them", () => {
    const plain = payload(
      buildCellModuleFrameSrcdoc({
        code: CELL,
        language: "react",
        theme: "light",
        hostModules: MODULES,
      })
    );
    expect(Object.keys(plain).sort()).toEqual(
      [
        "jsxRuntime",
        "react",
        "reactDom",
        "reactDomClient",
        "user",
        "viewSdk",
      ].sort()
    );
    expect(plain.user).toBe(CELL);
    expect(plain.viewSdk).toBe(SYNAP_VIEW_SDK);
    expect(plain.react).toBe(MODULES.react);

    const kitCode = `import { Card } from "@synap/kit";\nimport { jsxDEV } from "react/jsx-dev-runtime";\n${CELL}`;
    const withKit = payload(
      buildCellModuleFrameSrcdoc({
        code: kitCode,
        language: "react",
        theme: "light",
        hostModules: MODULES,
      })
    );
    expect(withKit.kit).toBe(MODULES.kit);
    expect(withKit.jsxDevRuntime).toBe(MODULES.jsxDevRuntime);
  });

  it("a plain module frame embeds no React at all", () => {
    const mod = payload(
      buildCellModuleFrameSrcdoc({
        code: "document.body.textContent = 'hi';",
        language: "module",
        theme: "light",
        hostModules: MODULES,
      })
    );
    expect(Object.keys(mod).sort()).toEqual(["user", "viewSdk"]);
  });

  it("writes the host's tokens and theme, and a tokens text cannot end its style", () => {
    const srcdoc = buildCellModuleFrameSrcdoc({
      code: CELL,
      language: "module",
      theme: "dark",
      hostModules: {
        tokensCss: ":root{--synap-a:1}</style><script>x()</script>",
      },
    });
    expect(srcdoc).toContain('<html data-theme="dark">');
    expect(srcdoc).not.toContain("</style><script>x()");
    const themed = buildCellModuleFrameSrcdoc({
      code: CELL,
      language: "module",
      theme: "dark",
      themeAttributes: 'data-theme="dark" data-synap-theme="nocturne"',
      hostModules: { tokensCss: "" },
    });
    expect(themed).toContain(
      '<html data-theme="dark" data-synap-theme="nocturne">'
    );
  });

  it("carries non-ASCII code intact (UTF-8 base64, as the frame decodes it)", () => {
    const code = "export default () => 'Créé — 日本 🎉';";
    expect(utf8ToBase64(code)).toBe(
      Buffer.from(code, "utf8").toString("base64")
    );
    for (const s of ["", "a", "ab", "abc", "abcd"])
      expect(utf8ToBase64(s)).toBe(Buffer.from(s, "utf8").toString("base64"));
    const decoded = payload(
      buildCellModuleFrameSrcdoc({
        code,
        language: "module",
        theme: "light",
        hostModules: { tokensCss: "" },
      })
    );
    expect(decoded.user).toBe(code);
  });

  it("no inlined script contains a closing script tag", () => {
    for (const s of [
      FRAME_BLOB_URLS_SCRIPT,
      FRAME_IMPORT_MAP_SCRIPT,
      FRAME_INIT_QUEUE_SCRIPT,
      SYNAP_WIDGET_SDK,
      SYNAP_VIEW_SDK,
    ])
      expect(s).not.toMatch(/<\/script/i);
  });

  it("the init queue says ready from a classic script and replays init to the module", () => {
    expect(FRAME_INIT_QUEUE_SCRIPT).toContain(
      "window.parent.postMessage({ type: 'synap:ready' }, '*')"
    );
    expect(FRAME_INIT_QUEUE_SCRIPT).toContain("window.__synapOnHostMessage");
  });
});

describe("what a module frame needs", () => {
  it("refuses a cell that asks the network for code", () => {
    expect(cellModuleNetworkRefusal(CELL)).toBe(null);
    expect(
      cellModuleNetworkRefusal(CELL, { react: "19", "@synap/kit": "1" })
    ).toBe(null);
    expect(cellModuleNetworkRefusal(CELL, { lodash: "4" })).toMatch(
      /loads lodash from the network/
    );
    expect(
      cellModuleNetworkRefusal('import x from "https://esm.sh/lodash";')
    ).toMatch(/esm\.sh/);
  });

  it("knows when the code imports the kit or the dev runtime", () => {
    expect(cellModuleNeedsKit('import { A } from "@synap/kit"')).toBe(true);
    expect(cellModuleNeedsKit("import x from '@synap/kit'")).toBe(true);
    expect(cellModuleNeedsKit("const k = '@synap/kitchen'")).toBe(false);
    expect(cellModuleNeedsJsxDev('from "react/jsx-dev-runtime"')).toBe(true);
    expect(cellModuleNeedsJsxDev(CELL)).toBe(false);
  });

  it("refuses a react frame its host cannot give React or the kit", () => {
    expect(cellModuleHostModulesRefusal(CELL, MODULES)).toBe(null);
    expect(cellModuleHostModulesRefusal(CELL, null)).toMatch(
      /needs react, react-dom, react-dom\/client, react\/jsx-runtime/
    );
    const { kit: _kit, ...noKit } = MODULES;
    expect(cellModuleHostModulesRefusal(CELL, noKit)).toBe(null);
    expect(
      cellModuleHostModulesRefusal('import { A } from "@synap/kit";', noKit)
    ).toMatch(/@synap\/kit/);
  });
});
