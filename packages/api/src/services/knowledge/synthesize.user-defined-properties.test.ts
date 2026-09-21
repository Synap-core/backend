/**
 * `ask()` must surface the property keys a USER-DEFINED kind actually uses.
 *
 * THE MEASURED FAILURE, live against the pod on 2026-09-21. Asked "what is
 * Synap's branding — colors, logo, voice, tagline?", `ask()` RETRIEVED exactly
 * the right rows — it cited `Synap Brand Identity`, `Synap Color Usage Rule`
 * and `Spine & Flow Token Set` as sources — and then answered:
 *
 *   "the actual colour values (hex codes, palette) are **not included** in the
 *    provided context"
 *   "No brand voice guidelines are present in the context"
 *   "Tagline: No formal tagline is listed"
 *
 * All three facts were IN those retrieved rows, under `rule-content`,
 * `brand-tagline` and `voice-tone-descriptors`. Retrieval was fine. The
 * `properties` bag was filtered through a six-key allowlist
 * (`content|conclusion|description|summary|body|notes`), so every
 * domain-named key was dropped before synthesis and the model truthfully
 * reported an absence that did not exist.
 *
 * WHY IT IS WORTH A TEST RATHER THAN A ONE-LINE FIX: the failure SCALES WITH
 * SCHEMA QUALITY. A kind modelled with well-named fields was MORE invisible
 * than a sloppy one that dumps everything into `content` — the reverse of
 * what the product promises. Any future "trim the context" change will be
 * tempted to reintroduce an allowlist.
 *
 * THE FIXTURES ARE THE REAL ROWS, copied verbatim from the pod (entity ids in
 * each case). A hand-invented `{ foo: "bar" }` fixture would pass under the
 * old code as easily as the new one if someone picked `content` as the key —
 * these rows are the ones that actually failed.
 *
 * WHAT THIS DOES NOT COVER, measured: it asserts what reaches the CONTEXT
 * STRING handed to the model. It does not run a model, so it cannot prove the
 * answer improves — only that the facts are no longer withheld. It also does
 * not cover non-string property values (objects/arrays are deliberately
 * skipped; see the scan's comment).
 */
import { describe, expect, it } from "vitest";
import { buildSynthesisContext } from "./synthesize.js";

/** Verbatim from pod entity 48bf79d2-ca69-41ba-84d7-ac33072a3be3. */
const COLOR_RULE = {
  id: "48bf79d2-ca69-41ba-84d7-ac33072a3be3",
  title: "Synap Color Usage Rule",
  properties: {
    title: "Synap Color Usage Rule",
    "rule-kind": "color-usage",
    "rule-content":
      "Synap uses a cool, sovereign, digital palette: deep emerald, electric cyan, slate.",
    "rule-subject": "color",
    "rule-severity": "mandatory",
  },
};

/** Verbatim from pod entity c2f04ae4-4bee-4909-9138-8a3c8ba1c2e3. */
const BRAND_IDENTITY = {
  id: "c2f04ae4-4bee-4909-9138-8a3c8ba1c2e3",
  title: "Synap",
  properties: {
    title: "Synap",
    "brand-type": "product",
    "brand-status": "active",
    "brand-tagline":
      "A sovereign data pod with a screen — typed second brain your own agent works through",
    "brand-website": "https://synap.live",
  },
};

const ctxFor = (items: Record<string, unknown>[]): string =>
  buildSynthesisContext([{ substrate: "semantic", items, status: "ok" }])
    .context;

describe("ask() context includes user-defined property keys", () => {
  it("NON-VACUITY: the row reaches the context at all (its title is present)", () => {
    // If the row were dropped entirely, every assertion below would fail for
    // the wrong reason and tell us nothing about property handling.
    expect(ctxFor([COLOR_RULE])).toContain("Synap Color Usage Rule");
  });

  it("THE LIVE FAILURE: the colour values are in the context, not dropped", () => {
    expect(
      ctxFor([COLOR_RULE]),
      "the palette lives in `rule-content`; dropping it is why ask() said " +
        "'the actual colour values are not included in the provided context'"
    ).toContain("deep emerald, electric cyan, slate");
  });

  it("THE LIVE FAILURE: the tagline is in the context, not dropped", () => {
    expect(
      ctxFor([BRAND_IDENTITY]),
      "the tagline lives in `brand-tagline`; dropping it is why ask() said " +
        "'no formal tagline is listed'"
    ).toContain("A sovereign data pod with a screen");
  });

  it("still surfaces the long-form allowlisted keys — no regression", () => {
    // The six known prose keys keep their larger budget and must not be lost
    // while widening the scan.
    const withContent = {
      id: "x",
      title: "A note",
      properties: { content: "the long-form body", summary: "the short one" },
    };
    const ctx = ctxFor([withContent]);
    expect(ctx).toContain("the long-form body");
    expect(ctx).toContain("the short one");
  });

  it("does not repeat `title`, which is already the first fragment", () => {
    const ctx = ctxFor([COLOR_RULE]);
    expect(ctx.match(/Synap Color Usage Rule/g)?.length ?? 0).toBe(1);
  });

  it("bounds a wide property bag so it cannot crowd out the body", () => {
    // A user kind with 40 fields must not blow the context budget; the cap is
    // a deliberate limit, and unlike the old allowlist it degrades by VOLUME
    // rather than by silently preferring six hardcoded names.
    const wide = {
      id: "w",
      title: "Wide",
      properties: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`field-${i}`, `value-${i}`])
      ),
    };
    const ctx = ctxFor([wide]);
    const surfaced = (ctx.match(/field-\d+:/g) ?? []).length;
    expect(surfaced).toBeGreaterThan(0);
    expect(surfaced).toBeLessThanOrEqual(8);
  });
});
