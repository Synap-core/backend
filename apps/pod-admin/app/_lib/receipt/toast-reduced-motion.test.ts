/**
 * A toast's exit slide is a CSS transform HeroUI sets on `data-toast-exiting`
 * (`translate-x-full`), not a framer animation, so the provider's
 * `reducedMotion="user"` never reaches it. The stylesheet answers it under
 * `prefers-reduced-motion`, and keeps an opacity transition because the toast
 * only closes on its `transitionend`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../../globals.css"), "utf8");

describe("the toast under reduced motion", () => {
  it("drops the exit slide and keeps an opacity transition to end on", () => {
    const block = css.match(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}\n/
    )?.[0];
    expect(block).toBeDefined();
    const rule = block!.match(
      /\[data-toast\]\[data-toast-exiting="true"\] \{([^}]*)\}/
    )?.[1];
    expect(rule, "a rule for the exiting toast").toBeDefined();
    expect(rule).toMatch(/transform:\s*none\s*!important/);
    expect(rule).toMatch(/transition-property:\s*opacity\s*!important/);
  });
});
