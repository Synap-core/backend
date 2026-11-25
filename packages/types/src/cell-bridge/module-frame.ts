/**
 * The frame a MODULE cell runs in (an ES module, usually a React component):
 * its sandbox, its timeouts, the host modules it needs, and the srcdoc that
 * puts the policy FIRST. The page frame's sibling (`frame.ts`, an HTML page):
 * same policy family (`buildCellModuleFrameCsp`), same bridge, one more power
 * (governed writes, `write-ops.ts`).
 *
 * Moved from synap-app `packages/web/src/cell-runtime/ViewFrame.tsx`
 * (`buildViewFrameSrcdoc`, `viewFrameNetworkRefusal`) and
 * `frame-react-modules.ts` (`frameNeeds*`), so every host builds the SAME
 * frame: the desktop's ViewFrame and pod admin's module frame. The host only
 * supplies its own React build and tokens (`CellFrameHostModules`), never its
 * own srcdoc.
 *
 * Pure: no DOM, no fetch. The base64 the frame decodes is computed here
 * without `btoa`, so it runs in any realm.
 */

import { buildCellModuleFrameCsp } from "./frame.js";
import { frameEsmShAt } from "./network-loads.js";
import {
  FRAME_BLOB_URLS_SCRIPT,
  FRAME_IMPORT_MAP_SCRIPT,
  FRAME_INIT_QUEUE_SCRIPT,
} from "./frame-scripts.js";
import { SYNAP_VIEW_SDK, SYNAP_WIDGET_SDK } from "./frame-sdks.js";
import { HOST_PROVIDED_FRAME_SPECIFIERS } from "../renderables/cell-source-checks.js";
import type { Locale } from "../i18n/locale.js";
import {
  frameTokensWithBrand,
  type SurfaceContextAnchor,
  type SurfaceContextBrand,
} from "./surface-context.js";

/**
 * The iframe `sandbox` value of a module frame, exactly: scripts and modal
 * dialogs (`alert`, `confirm`). NEVER `allow-same-origin`, and NEVER
 * `allow-popups`: removed 2026-09-07, `window.open` was an exfiltration
 * channel (the desktop opens any http(s) URL in an in-app tab).
 */
export const CELL_MODULE_FRAME_SANDBOX = "allow-scripts allow-modals";

/** A frame that never says `synap:ready` within this is failed. */
export const CELL_FRAME_READY_TIMEOUT_MS = 5_000;
/** A frame that said ready but never `synap:mounted` within this is failed. */
export const CELL_FRAME_MOUNT_TIMEOUT_MS = 15_000;

/**
 * The modules the HOST hands a frame, as source text from one build: React,
 * react-dom, react-dom/client, the JSX runtimes and the kit must come from the
 * SAME build (one React instance in the frame). `tokensCss` is the host's
 * `--synap-*` tokens in the reader's theme, written as the frame's first style.
 */
export type CellFrameHostModules = {
  react: string;
  /** `react-dom` (portals, flushSync), built against the frame's `react`. */
  reactDom: string;
  /** `react-dom/client`, built against the frame's `react` and `react-dom`. */
  reactDomClient: string;
  /** `react/jsx-runtime`, against the frame's `react`. */
  jsxRuntime: string;
  /** `react/jsx-dev-runtime` (development builds only). */
  jsxDevRuntime?: string;
  /** `@synap/kit`: the shared components a space package imports. */
  kit?: string;
  /** The host's design tokens as CSS, in the reader's theme. */
  tokensCss: string;
};

/** What a host passes to build one frame: the tokens always, the modules a react frame needs. */
export type CellFrameModuleInputs = Pick<CellFrameHostModules, "tokensCss"> &
  Partial<Omit<CellFrameHostModules, "tokensCss">>;

/** Where the init context says the frame reads, mirrored from synap-app's `WorkspaceScope`. */
export type CellFrameWorkspaceScope =
  | { type: "active" }
  | { type: "workspace"; workspaceId: string }
  | { type: "multi"; workspaceIds?: string[] }
  | { type: "pod" }
  | { type: "workspaceType"; kind: string; capability?: string };

/** A bound view's query hint (synap-app `SynapQueryHint`): only what `entities.list` serves. */
export interface CellFrameQueryHint {
  profileSlug?: string;
  filters?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}

/**
 * The context `synap:init` carries into the frame (synap-app
 * `SynapWidgetInitContext`). Only non-secret identifiers, all host-stamped:
 * never a token, a pod URL or a key.
 */
export interface CellFrameInitContext {
  workspaceId: string;
  /** The space's display name, stamped by the host from its own read. */
  workspaceName?: string;
  workspaceScope?: CellFrameWorkspaceScope;
  viewId?: string;
  profileSlug?: string;
  entityId?: string;
  /** The bound view's query hint, host-derived from the view's stored query. */
  query?: CellFrameQueryHint;
  sdkVersion?: "1" | "2";
  /** Active host theme; the frame applies it to `<html data-theme>`. */
  theme?: "light" | "dark";
  /**
   * The language the host's chrome speaks (`@synap-core/types/i18n`
   * `Locale`, the reader's own setting as the host resolved it): the frame's
   * words follow it. Absent from an older host: the frame keeps its default.
   */
  locale?: Locale;
  /*
   * Frame contract v3 (`SurfaceContext`, `surfaceContextInitFields`): what
   * the frame is about. Absent from an older host; `null` when there is none.
   */
  /** The object the frame is anchored to. */
  anchor?: SurfaceContextAnchor | null;
  /** The project the anchor belongs to. */
  projectId?: string | null;
  /** The goal (track) the anchor serves. */
  goalId?: string | null;
  /** The host's filters on what the frame shows. */
  filters?: Record<string, unknown>;
  /** The project's brand; its CSS is already in the frame's tokens. */
  brand?: SurfaceContextBrand | null;
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * `btoa(unescape(encodeURIComponent(source)))`, without `btoa`: the UTF-8
 * bytes of `source` in base64, decoded in the frame by
 * `decodeURIComponent(escape(atob(b64)))` (`FRAME_BLOB_URLS_SCRIPT`).
 */
export function utf8ToBase64(source: string): string {
  const bytes = unescape(encodeURIComponent(source));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes.charCodeAt(i);
    const b = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : -1;
    const c = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : -1;
    out += BASE64[a >> 2];
    out += BASE64[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)];
    out += b < 0 ? "=" : BASE64[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)];
    out += c < 0 ? "=" : BASE64[c & 63];
  }
  return out;
}

/** Whether a frame's code imports the development JSX runtime. */
export function cellModuleNeedsJsxDev(code: string): boolean {
  return code.includes("react/jsx-dev-runtime");
}

/** Whether a frame's code imports the shared kit (a space package does). */
export function cellModuleNeedsKit(code: string): boolean {
  return /["']@synap\/kit["']/.test(code);
}

const PROVIDED = new Set(HOST_PROVIDED_FRAME_SPECIFIERS);

/**
 * Why this frame cannot run, when it asks for code from the network: a
 * declared runtime dependency the host does not provide, or a source that
 * names esm.sh (`frameEsmShAt`). Null when it can. A MODULE cell's rule; a
 * stored HTML page's is `frameNetworkCodeRefusal` (`network-loads.ts`).
 */
export function cellModuleNetworkRefusal(
  code: string,
  deps: Record<string, string> = {}
): string | null {
  const remote = Object.keys(deps).filter((name) => !PROVIDED.has(name));
  if (remote.length > 0) {
    return `This view loads ${remote.join(", ")} from the network, which views no longer do. Rebuild it with its dependencies bundled (synap cell build --bundle-deps).`;
  }
  if (frameEsmShAt(code) >= 0) {
    return "This view loads code from esm.sh, which views no longer do. Rebuild it with its dependencies bundled (synap cell build --bundle-deps).";
  }
  return null;
}

/**
 * Why a REACT frame cannot run with the modules this host has: React, its
 * DOM, the JSX runtime, and the dev runtime or the kit when the code imports
 * them. Null when every module it needs is here. A host without the kit (pod
 * admin before its bundle is installed) shows this instead of a frame that
 * fails at import.
 */
export function cellModuleHostModulesRefusal(
  code: string,
  modules: Partial<CellFrameHostModules> | null | undefined
): string | null {
  const missing: string[] = [];
  const has = (k: keyof CellFrameHostModules) => {
    const v = modules?.[k];
    return typeof v === "string" && v.length > 0;
  };
  if (!has("react")) missing.push("react");
  if (!has("reactDom")) missing.push("react-dom");
  if (!has("reactDomClient")) missing.push("react-dom/client");
  if (!has("jsxRuntime")) missing.push("react/jsx-runtime");
  if (cellModuleNeedsJsxDev(code) && !has("jsxDevRuntime"))
    missing.push("react/jsx-dev-runtime");
  if (cellModuleNeedsKit(code) && !has("kit")) missing.push("@synap/kit");
  if (missing.length === 0) return null;
  return `This view needs ${missing.join(", ")}, which this app does not provide.`;
}

export interface CellModuleFrameInput {
  /** ES module source: a default-exported React component, or a self-mounting module. */
  code: string;
  /** `react` mounts the default export with `createRoot`; `module` imports it as-is. */
  language: "react" | "module";
  /** The reader's theme, baked into the first paint (live changes are `synap:theme`). */
  theme: "light" | "dark";
  /** The `<html>` attributes; default `data-theme="<theme>"`. */
  themeAttributes?: string;
  /** Origins an approved cell may reach (`connect-src`, `img-src`); none by default. */
  externalHosts?: readonly string[];
  /** The host's modules (React and the kit for a react frame) and its tokens. */
  hostModules: CellFrameModuleInputs;
  /** The project's brand CSS (`SurfaceContext.brand.css`), written after the host's tokens. */
  brandCss?: string | null;
}

/**
 * The whole srcdoc of a module frame. In the head, in this order: the CSP
 * `<meta>` FIRST (it governs every load after it), the host's tokens, the
 * base styles, the host modules as base64 JSON, then the classic scripts
 * (blob URLs → import map → `SynapWidget` → `SynapView` → ready + init queue),
 * then the module that boots the cell on `synap:init`.
 *
 * A react frame embeds React, its DOM and the JSX runtime; the dev runtime
 * and the kit only when its code imports them (each is megabytes). A module
 * frame embeds none of them.
 */
export function buildCellModuleFrameSrcdoc(
  input: CellModuleFrameInput
): string {
  const { code, language, theme, hostModules } = input;
  const react = language === "react";
  // Host-inlined module sources, decoded inside the iframe into blob: URLs.
  // SYNAP_VIEW_SDK is also a classic <script> (window.SynapView). The blob
  // entry is only for `import { createSynapView } from '@synap/view-sdk'`.
  const modulePayload: Record<string, string> = {
    user: utf8ToBase64(code),
    viewSdk: utf8ToBase64(SYNAP_VIEW_SDK),
  };
  if (react) {
    const add = (key: string, source: string | undefined) => {
      if (source) modulePayload[key] = utf8ToBase64(source);
    };
    add("react", hostModules.react);
    add("jsxRuntime", hostModules.jsxRuntime);
    if (cellModuleNeedsJsxDev(code))
      add("jsxDevRuntime", hostModules.jsxDevRuntime);
    add("reactDom", hostModules.reactDom);
    add("reactDomClient", hostModules.reactDomClient);
    if (cellModuleNeedsKit(code)) add("kit", hostModules.kit);
  }

  // reactBoot runs INSIDE the module's try-block, but the bootstrap runs in
  // `onHost`, which is declared OUTSIDE it: a `const` declared here is out of
  // scope there. So both handles go through window.
  const reactBoot = react
    ? `const ReactMod = await import('react');
    const client = await import('react-dom/client');
    window.__React = ReactMod.default || ReactMod;
    window.__createRoot = client.createRoot;
`
    : "";

  const bootstrap = react
    ? `
    import(window.__synapModuleBlobs.user).then(function(mod) {
      const Component = mod.default;
      if (typeof Component !== 'function') {
        window.SynapWidget.error('ViewFrame: module default export is not a React component');
        return;
      }
      window.__createRoot(document.getElementById('root')).render(
        window.__React.createElement(Component)
      );
      window.parent.postMessage({ type: 'synap:mounted' }, '*');
    }).catch(function(err) {
      window.SynapWidget.error('ViewFrame render error: ' + String(err));
    });
`
    : `
    import(window.__synapModuleBlobs.user).then(function() {
      window.parent.postMessage({ type: 'synap:mounted' }, '*');
    }).catch(function(err) {
      window.SynapWidget.error('ViewFrame module error: ' + String(err));
    });
`;

  const csp = buildCellModuleFrameCsp(input.externalHosts ?? []);
  const htmlAttributes = input.themeAttributes ?? `data-theme="${theme}"`;
  // The host's tokens, then the brand's (`<\/` cannot end the element).
  const tokens = frameTokensWithBrand(hostModules.tokensCss, input.brandCss);

  return `<!DOCTYPE html>
<html ${htmlAttributes}>
<head>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="utf-8">
<style>
${tokens}
</style>
<style>
* { box-sizing: border-box; margin: 0; }
html, body { width: 100%; height: 100%; overflow: auto; }
body {
  font-family: var(--synap-font-body);
  color: var(--synap-color);
  background: transparent;
}
</style>
<script type="application/json" id="synap-frame-modules">${JSON.stringify(modulePayload)}</script>
<script>${FRAME_BLOB_URLS_SCRIPT}</script>
<script>${FRAME_IMPORT_MAP_SCRIPT}</script>
<script>
${SYNAP_WIDGET_SDK}
</script>
<script>
${SYNAP_VIEW_SDK}
</script>
<script>${FRAME_INIT_QUEUE_SCRIPT}</script>
</head>
<body>
<div id="root" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--synap-muted);font-size:var(--synap-text-sm);">Loading…</div>
<script type="module">
(async function () {
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') {
      document.documentElement.dataset.theme = t;
    }
  }
  var booted = false;
  function onHost(msg) {
    if (!msg) return;
    if (msg.type === 'synap:theme') {
      applyTheme(msg.theme);
      return;
    }
    if (msg.type !== 'synap:init') return;
    if (booted) return;
    booted = true;
    if (msg.context) applyTheme(msg.context.theme);
    ${bootstrap}
  }
  try {
    ${reactBoot}
    if (typeof window.__synapOnHostMessage === 'function') {
      window.__synapOnHostMessage(onHost);
    } else {
      window.addEventListener('message', function (e) { onHost(e.data); });
    }
  } catch (err) {
    window.SynapWidget.error('ViewFrame React import failed: ' + String(err));
  }
})();
</script>
</body>
</html>`;
}
