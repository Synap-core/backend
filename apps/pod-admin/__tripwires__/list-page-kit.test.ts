import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../scripts/strip-comments.mjs";

/**
 * One list page (founder, 2026-11-07, after decision afab5911): every list
 * page is a header, ONE toolbar row and a card, drawn by the kit in
 * `components/list-page.tsx`. The pages below were the ones that drew their
 * own: a native select, a switch and a raw-id input over a hand-made card
 * (Entities), a card with its own search and state ladder (Templates, Runs).
 *
 * Fails when one of them (1) stops drawing its card with `ListCard`, (2)
 * draws its filters with HeroUI `Select`/`Switch`, or (3) draws a hand-made
 * loading/error/empty ladder. Pages are listed here ON PURPOSE: a page joins
 * the list when it is migrated. Not covered: a page not yet on the list
 * (the follow-up list in the PR body).
 */

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const MIGRATED = [
  "app/(admin)/entities/page.tsx",
  "app/(admin)/templates/page.tsx",
  "app/(admin)/runs/page.tsx",
];

/**
 * Runs keeps ResourceRow's states for `FlowRuns`, the runs expanded inside one
 * flow row: a nested strip, not a list card (justified keep).
 */
const NESTED_STATES = new Set(["app/(admin)/runs/page.tsx"]);

function source(rel: string): string {
  return stripComments(readFileSync(join(APP_ROOT, rel), "utf8"), "ts");
}

describe("migrated list pages use the list kit", () => {
  for (const rel of MIGRATED) {
    const text = source(rel);
    it(`${rel} draws its card with ListCard`, () => {
      expect(text).toMatch(/<ListCard\b/);
      expect(text).not.toMatch(/<SectionCard\b/);
    });
    it.skipIf(NESTED_STATES.has(rel))(
      `${rel} has no hand-made state ladder`,
      () => {
        expect(text).not.toMatch(/<ResourceRow(Skeleton|Error|Empty)\b/);
      }
    );
    it(`${rel} draws no filter with Select or Switch`, () => {
      expect(text).not.toMatch(/<(Select|Switch)\b/);
    });
  }
});
