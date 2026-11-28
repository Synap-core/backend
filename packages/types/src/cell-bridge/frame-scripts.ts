/**
 * The three classic scripts every MODULE frame runs before its module, as
 * strings a host inlines into the srcdoc (`buildCellModuleFrameSrcdoc`,
 * `module-frame.ts`). Moved verbatim from synap-app
 * `packages/web/src/cell-runtime/frame-{blob-urls,import-map,init-queue}.ts`
 * (ViewFrame's runtime): one copy, here, for every host (the desktop's
 * ViewFrame, pod admin's module frame).
 *
 * Order in the frame: `CELL_FRAME_CHANNEL_SCRIPT` (`frame-channel.ts`: the
 * reply port, handed over first) → `FRAME_BLOB_URLS_SCRIPT` (host-inlined module sources →
 * same-origin `blob:null/…` URLs) → `FRAME_IMPORT_MAP_SCRIPT` (the import map
 * from those URLs) → the SDKs → `FRAME_INIT_QUEUE_SCRIPT` (says ready, queues
 * init). Nothing remote: the frame's policy names no origin.
 *
 * Plain ES5 in strings; none contains a closing script tag (a test pins it).
 */

/**
 * Classic script: turn host-inlined module source (base64 JSON) into blob:
 * URLs on the iframe's own opaque origin.
 *
 * Host-built `data:` import-map URLs fail here — Chromium `import()` of a
 * large data: URL from `about:srcdoc` (sandbox without allow-same-origin)
 * throws "Failed to fetch dynamically imported module: data:text/javascript…".
 * `URL.createObjectURL` inside this frame yields `blob:null/<uuid>`, which
 * is same-origin to the iframe and loadable.
 */
export const FRAME_BLOB_URLS_SCRIPT = `(function () {
  var el = document.getElementById('synap-frame-modules');
  if (!el || !el.textContent) return;
  var mods = JSON.parse(el.textContent);
  function toBlob(b64) {
    var src = decodeURIComponent(escape(atob(b64)));
    return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  }
  var blobs = {};
  for (var k in mods) {
    if (Object.prototype.hasOwnProperty.call(mods, k) && typeof mods[k] === 'string') {
      blobs[k] = toBlob(mods[k]);
    }
  }
  window.__synapModuleBlobs = blobs;
})();`;

/**
 * Classic script: register the iframe import map from the host modules' blob URLs
 * (React, its JSX runtimes, react-dom, the view SDK, the kit). Nothing remote.
 *
 * Must run after FRAME_BLOB_URLS_SCRIPT and before the first <script type="module">.
 */
export const FRAME_IMPORT_MAP_SCRIPT = `(function () {
  var blobs = window.__synapModuleBlobs || {};
  var imports = {};
  if (blobs.react) imports['react'] = blobs.react;
  // The automatic JSX runtime (jsx, jsxs, Fragment), never react in its place.
  if (blobs.jsxRuntime) imports['react/jsx-runtime'] = blobs.jsxRuntime;
  if (blobs.jsxDevRuntime) imports['react/jsx-dev-runtime'] = blobs.jsxDevRuntime;
  if (blobs.reactDomClient) imports['react-dom/client'] = blobs.reactDomClient;
  // The real react-dom (createPortal, flushSync), never the client in its place.
  if (blobs.reactDom) imports['react-dom'] = blobs.reactDom;
  if (blobs.viewSdk) imports['@synap/view-sdk'] = blobs.viewSdk;
  // The shared kit a space package imports (space-packages/kit.ts).
  if (blobs.kit) imports['@synap/kit'] = blobs.kit;
  var tag = document.createElement('script');
  tag.type = 'importmap';
  tag.textContent = JSON.stringify({ imports: imports });
  document.head.appendChild(tag);
})();`;

/**
 * Classic-script handshake for a module frame.
 *
 * Classic `synap:ready` must fire before the module that imports React, or a
 * hung import produces a 5s timeout instead of a real error. The host then
 * posts `synap:init` immediately. If the module listener is not attached yet,
 * that init is lost, `#root` stays empty, host status is `ready`, and the user
 * sees a blank panel.
 *
 * This script runs with no imports: it queues the last init/theme and replays
 * them when the module registers `__synapOnHostMessage`.
 */
export const FRAME_INIT_QUEUE_SCRIPT = `(function () {
  var pendingInit = null;
  var pendingTheme = null;
  var consumer = null;
  function deliver(msg) {
    if (!consumer) return;
    try { consumer(msg); } catch (err) {
      if (window.SynapWidget && typeof window.SynapWidget.error === 'function') {
        window.SynapWidget.error(String(err));
      }
    }
  }
  window.addEventListener('message', function (e) {
    if (!e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'synap:theme') {
      pendingTheme = e.data;
      deliver(e.data);
      return;
    }
    if (e.data.type === 'synap:init') {
      pendingInit = e.data;
      deliver(e.data);
    }
  });
  window.__synapOnHostMessage = function (fn) {
    consumer = fn;
    if (pendingTheme) deliver(pendingTheme);
    if (pendingInit) deliver(pendingInit);
  };
  window.parent.postMessage({ type: 'synap:ready' }, '*');
})();`;
