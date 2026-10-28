/**
 * The in-frame SDK, as a script string the host injects before the page's own
 * scripts. It gives the page one call:
 *
 *   window.synap.query(op, params) → Promise<data>
 *
 * which posts `synap:query` to the parent and resolves with the matching
 * `synap:query:result` (rejects with its `error`, or after 30 s with no
 * answer). `window.synap.mutate(op, payload)` exists so a page written for a
 * writing host fails loudly here: the host refuses it and the promise
 * rejects with the refusal. `window.synap.ops` lists the readable ops.
 *
 * It only accepts answers from `window.parent` — the host — and only for an
 * id it sent. It holds no token and no pod address: there is none to hold.
 *
 * Plain ES2015 in a string, so any host can inline it into a srcdoc. It never
 * contains a closing script tag (a test pins that).
 */

import { CELL_BRIDGE_READ_OP_NAMES } from "./read-ops.js";

export const CELL_BRIDGE_SDK = `(function () {
  "use strict";
  if (window.synap && window.synap.bridge === "synap-cell-bridge/1") return;
  var parentWindow = window.parent;
  var pending = Object.create(null);
  var seq = 0;
  var TIMEOUT_MS = 30000;
  window.addEventListener("message", function (event) {
    if (event.source !== parentWindow) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object" || typeof msg.id !== "string") return;
    if (msg.type !== "synap:query:result" && msg.type !== "synap:mutate:result") return;
    var call = pending[msg.id];
    if (!call) return;
    delete pending[msg.id];
    clearTimeout(call.timer);
    if (typeof msg.error === "string") call.reject(new Error(msg.error));
    else call.resolve(msg.data);
  });
  function ask(type, operation, body) {
    return new Promise(function (resolve, reject) {
      var id = "synap-" + (++seq) + "-" + Date.now().toString(36);
      var name = String(operation);
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error("The pod did not answer \\"" + name + "\\" in time."));
      }, TIMEOUT_MS);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      var msg = { type: type, id: id, operation: name };
      if (type === "synap:query") msg.params = body || {};
      else msg.payload = body || {};
      try {
        parentWindow.postMessage(msg, "*");
      } catch (err) {
        delete pending[id];
        clearTimeout(timer);
        reject(err);
      }
    });
  }
  window.synap = Object.freeze({
    bridge: "synap-cell-bridge/1",
    ops: Object.freeze(${JSON.stringify(CELL_BRIDGE_READ_OP_NAMES)}),
    query: function (operation, params) {
      return ask("synap:query", operation, params);
    },
    mutate: function (operation, payload) {
      return ask("synap:mutate", operation, payload);
    }
  });
})();`;
