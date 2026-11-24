/**
 * A stored HTML card is written for the widget host (`window.SynapWidget`:
 * `onInit`, `query`, `navigate`, the host's `--synap-*` tokens). Pod admin's
 * frame only ever gave a page `window.synap` (the read bridge), so a card's
 * first line threw `SynapWidget is not defined` and it sat on "Loading…"
 * forever (Person card, 13 Nov 2026).
 *
 * `withWidgetCompat` puts a small compat block in front of such a page, INSIDE
 * the frame, after the frame's own policy and SDK (it relies on `window.synap`
 * being there):
 *
 *   - `SynapWidget.onInit(fn)` calls `fn` once, with the init the card reads
 *     (`{ context }`, and the context as the second argument).
 *   - `SynapWidget.query` / `mutate` forward to `window.synap`, so a card's
 *     reads still go through the host bridge and its floor, never anywhere new.
 *   - `navigate`, `resize`, `toast`, `error`, `openPanel`, `onUpdate` and
 *     `subscribe` are accepted and do nothing: pod admin is not the work
 *     surface, so a card's "open this" has nowhere to go here.
 *   - The five `--synap-*` tokens the cards draw with, in the light palette
 *     (the frame is a white page; values from `app/synap-tokens.css`'s light
 *     block). A frame is its own document: the console's tokens do not reach it.
 *
 * With `sample`, the entity a card asks for (`entities.get`) is answered from
 * a sample person INSIDE the frame, and the card is given its id: a preview of
 * a card nobody approved yet draws something real-looking while the host
 * answers no pod read at all.
 *
 * It does not widen the sandbox or the policy: it is one inline script and one
 * inline style, both already allowed, and adds no origin.
 */

/** What a preview shows in place of the viewer's own data. Never a pod record. */
export const PREVIEW_SAMPLE_ENTITY = {
  id: "00000000-0000-4000-8000-000000000000",
  title: "Léa Martin",
  facetSlugs: ["client"],
  status: "active",
  properties: {
    jobTitle: "Head of Operations",
    email: "lea.martin@example.com",
    phone: "+33 6 12 34 56 78",
    linkedinUrl: "https://www.linkedin.com/in/lea-martin",
    industry: "Logistics",
    website: "https://example.com",
    source: "Referral",
    decisionStatus: "decided",
    summary: "Move the nightly release to 18:30 UTC.",
    rationale: "Every main commit is green by then.",
    severity: "medium",
    area: "ci",
    evidence: "Preflight run 43233011901",
    priority: "high",
    dueDate: "2026-11-20",
  },
} as const;

const LIGHT_TOKENS = `:root{--synap-foreground:#26211c;--synap-background:#ffffff;--synap-border:rgba(50,38,22,.16);--synap-primary:#a86e2e;--synap-primary-foreground:#ffffff}`;

/** The widget API names a card calls: the cue that a page is written for it. */
const WIDGET_HOST_API = /\bSynapWidget\b/;

/** Whether a page is written for the widget host. */
export function usesWidgetHost(html: string): boolean {
  return WIDGET_HOST_API.test(html);
}

/** `<` in JSON must never be able to close the script that carries it. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The compat block, as markup: one style, one script, no closing-tag text inside. */
export function widgetCompatBlock({ sample }: { sample: boolean }): string {
  const script = `(function(){
  "use strict";
  if (window.SynapWidget) return;
  var SAMPLE = ${sample ? inlineJson(PREVIEW_SAMPLE_ENTITY) : "null"};
  var ctx = { workspaceId: "", entityId: SAMPLE ? SAMPLE.id : undefined, sdkVersion: "2", theme: "light" };
  var none = function () {};
  window.SynapWidget = {
    onInit: function (fn) {
      Promise.resolve().then(function () { fn({ context: ctx }, ctx); });
    },
    onUpdate: none, resize: none, toast: none, error: none, navigate: none, openPanel: none,
    subscribe: function () { return none; },
    query: function (operation, params) {
      if (SAMPLE && operation === "entities.get") return Promise.resolve(SAMPLE);
      return window.synap.query(operation, params);
    },
    mutate: function (operation, payload) { return window.synap.mutate(operation, payload); }
  };
})();`;
  return `<style>${LIGHT_TOKENS}</style><script>${script}</script>`;
}

const LEADING_DOCTYPE = /^(\uFEFF?\s*<!doctype[^>]*>)/i;

/**
 * The page with the compat block in front of it (after a leading doctype, so
 * the page keeps its rendering mode), or the page untouched when it does not
 * use the widget host. Hand the result to `wrapHtmlForFrame`: the policy and
 * the SDK go in ahead of this block.
 */
export function withWidgetCompat(
  html: string,
  { sample }: { sample: boolean }
): string {
  if (!usesWidgetHost(html)) return html;
  const block = widgetCompatBlock({ sample });
  const doctype = LEADING_DOCTYPE.exec(html);
  if (!doctype) return block + html;
  const lead = doctype[1]!;
  return lead + block + html.slice(lead.length);
}
