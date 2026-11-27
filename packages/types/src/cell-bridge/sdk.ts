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
 *   window.synap.open(kind, id)
 *
 * asks the host to open one object (`synap:surface:open`, `frame-links.ts`):
 * a session, an entity, a document… named by its id. The host decides where
 * it opens; nothing comes back (`window.synap.opens` lists the kinds).
 *
 *   window.synap.context() → Promise<SurfaceContext>
 *
 * asks the host what the page is about (`synap:context`, frame contract v3,
 * `surface-context.ts`): its anchor, space, project, goal, filters, brand,
 * locale and theme. Rejects when the host gives no context.
 *
 * A page that marks slides (`data-slide`, `slides.ts`) can be presented:
 * the host posts `synap:slide:goto` and the SDK shows that slide alone
 * (`html[data-synap-presenting]`), scrolls to it and answers
 * `synap:slide:changed`; the arrow keys, Space and Page Up/Down move it while
 * focus is in the frame, reported the same way. Printing shows every slide,
 * one per page.
 *
 * It only accepts answers from `window.parent` — the host — and only for an
 * id it sent. The host answers on the reply port the frame handed it
 * (`frame-channel.ts`, which runs first and re-dispatches each answer as a
 * message from `window.parent`), never on the frame's window. It holds no
 * token and no pod address: there is none to hold.
 *
 * Plain ES2015 in a string, so any host can inline it into a srcdoc. It never
 * contains a closing script tag (a test pins that).
 */

import { CELL_BRIDGE_READ_OP_NAMES } from "./read-ops.js";
import { FRAME_OPEN_KINDS, FRAME_SURFACE_OPEN_TYPE } from "./frame-links.js";
import {
  FRAME_SLIDE_ATTRIBUTE,
  FRAME_SLIDE_CHANGED_TYPE,
  FRAME_SLIDE_GOTO_TYPE,
} from "./slides.js";

/**
 * While presenting, every slide but the current one is hidden on screen; a
 * print shows them all, one per page.
 */
const SLIDE_CSS =
  `@media screen{html[data-synap-presenting] [${FRAME_SLIDE_ATTRIBUTE}]:not([data-synap-slide-current]){display:none !important}}` +
  `@media print{[${FRAME_SLIDE_ATTRIBUTE}]{break-after:page;page-break-after:always}}`;

export const CELL_BRIDGE_SDK = `(function () {
  "use strict";
  if (window.synap && window.synap.bridge === "synap-cell-bridge/1") return;
  var parentWindow = window.parent;
  var pending = Object.create(null);
  var seq = 0;
  var TIMEOUT_MS = 30000;
  var doc = window.document;
  var SLIDE = ${JSON.stringify(FRAME_SLIDE_ATTRIBUTE)};
  var slideAt = -1;
  function slideList() {
    if (!doc || !doc.querySelectorAll) return [];
    return Array.prototype.slice.call(doc.querySelectorAll("[" + SLIDE + "]"));
  }
  function slideIdOf(el, n) {
    var block = String(el.getAttribute("data-block-id") || "").trim();
    if (block) return block;
    var named = String(el.getAttribute(SLIDE) || "").trim();
    return named || "slide-" + n;
  }
  function showSlide(slides, index) {
    if (!doc.getElementById("synap-slide-style")) {
      var style = doc.createElement("style");
      style.id = "synap-slide-style";
      style.textContent = ${JSON.stringify(SLIDE_CSS)};
      (doc.head || doc.documentElement).appendChild(style);
    }
    doc.documentElement.setAttribute("data-synap-presenting", "");
    for (var i = 0; i < slides.length; i++) {
      if (i === index) slides[i].setAttribute("data-synap-slide-current", "");
      else slides[i].removeAttribute("data-synap-slide-current");
    }
    slideAt = index;
    if (slides[index].scrollIntoView) slides[index].scrollIntoView({ block: "start" });
    parentWindow.postMessage(
      {
        type: ${JSON.stringify(FRAME_SLIDE_CHANGED_TYPE)},
        slideId: slideIdOf(slides[index], index + 1),
        index: index,
        total: slides.length
      },
      "*"
    );
  }
  function gotoSlide(msg) {
    var slides = slideList();
    if (!slides.length) return;
    var at = -1;
    if (typeof msg.slideId === "string") {
      for (var i = 0; i < slides.length; i++) {
        if (slideIdOf(slides[i], i + 1) === msg.slideId) { at = i; break; }
      }
    }
    if (at < 0 && typeof msg.index === "number" && msg.index >= 0 && msg.index < slides.length) {
      at = Math.floor(msg.index);
    }
    if (at >= 0) showSlide(slides, at);
  }
  window.addEventListener("keydown", function (event) {
    if (slideAt < 0 || event.defaultPrevented) return;
    var t = event.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""))) return;
    var step = 0;
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown" || event.key === " ") step = 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") step = -1;
    if (!step) return;
    var slides = slideList();
    var next = slideAt + step;
    event.preventDefault();
    if (next < 0 || next >= slides.length) return;
    showSlide(slides, next);
  });
  window.addEventListener("message", function (event) {
    if (event.source !== parentWindow) return;
    var msg = event.data;
    if (msg && msg.type === ${JSON.stringify(FRAME_SLIDE_GOTO_TYPE)}) {
      gotoSlide(msg);
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.id !== "string") return;
    if (
      msg.type !== "synap:query:result" &&
      msg.type !== "synap:mutate:result" &&
      msg.type !== "synap:context:result"
    ) return;
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
      var msg = { type: type, id: id };
      if (type !== "synap:context") msg.operation = name;
      if (type === "synap:query") msg.params = body || {};
      else if (type === "synap:mutate") msg.payload = body || {};
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
    },
    context: function () {
      return ask("synap:context", "context");
    },
    opens: Object.freeze(${JSON.stringify(FRAME_OPEN_KINDS)}),
    open: function (kind, id) {
      parentWindow.postMessage(
        {
          type: "${FRAME_SURFACE_OPEN_TYPE}",
          surface: { kind: "object", objectKind: String(kind), objectId: String(id) }
        },
        "*"
      );
    }
  });
})();`;
