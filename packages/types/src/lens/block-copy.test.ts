/**
 * The block words every client draws (en + fr): sound catalogs, one title and
 * one why per attention class, the placeholder's three states with their one
 * act, and the key list pinned (a renamed key strands every client).
 */
import { describe, expect, it } from "vitest";
import { catalogProblems } from "../i18n/index.js";
import {
  LENS_EMPTY_TITLE_KEY,
  LENS_EMPTY_WHY_KEY,
  lensBlockCopy,
  lensEmptyTitle,
  lensEmptyWhy,
} from "./block-copy.js";
import {
  BLOCK_PLACEHOLDER_ACT,
  BLOCK_PLACEHOLDER_STATES,
  blockPlaceholder,
} from "./block-placeholder.js";
import { ATTENTION_CLASSES } from "./sections.js";

describe("lens block copy", () => {
  it("the French catalog has every key, the same arguments, no extra", () => {
    expect(catalogProblems(lensBlockCopy)).toEqual([]);
  });

  it("every attention class has its title and its why, in both languages", () => {
    expect(Object.keys(LENS_EMPTY_TITLE_KEY)).toEqual([...ATTENTION_CLASSES]);
    expect(Object.keys(LENS_EMPTY_WHY_KEY)).toEqual([...ATTENTION_CLASSES]);
    for (const cls of ATTENTION_CLASSES) {
      for (const locale of ["en", "fr"] as const) {
        expect(
          lensEmptyTitle(cls, locale).length,
          `${cls} ${locale}`
        ).toBeGreaterThan(0);
        expect(
          lensEmptyWhy(cls, locale).length,
          `${cls} ${locale}`
        ).toBeGreaterThan(0);
      }
    }
    expect(lensEmptyTitle("blocking", "en")).toBe("All clear");
    expect(lensEmptyTitle("blocking", "fr")).toBe("Rien ne vous attend");
    expect(lensEmptyWhy("proposed", "en")).toBe(
      "The AI's suggestions and drafts land here."
    );
  });

  it("the placeholder: three states, one act each, no retry without access", () => {
    expect([...BLOCK_PLACEHOLDER_STATES]).toEqual([
      "unsupported",
      "no-access",
      "failed",
    ]);
    expect(Object.keys(BLOCK_PLACEHOLDER_ACT)).toEqual([
      ...BLOCK_PLACEHOLDER_STATES,
    ]);
    expect(blockPlaceholder("unsupported", "en")).toEqual({
      state: "unsupported",
      title: "Can’t show this block here",
      act: { kind: "open", label: "Open in app" },
    });
    expect(blockPlaceholder("no-access", "en")).toEqual({
      state: "no-access",
      title: "This block isn’t shared with you",
      act: null,
    });
    expect(blockPlaceholder("failed", "fr")).toEqual({
      state: "failed",
      title: "Impossible de charger ce bloc",
      act: { kind: "retry", label: "Réessayer" },
    });
    // Three different titles: a reader must tell the states apart.
    const titles = BLOCK_PLACEHOLDER_STATES.map(
      (s) => blockPlaceholder(s, "en").title
    );
    expect(new Set(titles).size).toBe(BLOCK_PLACEHOLDER_STATES.length);
  });

  it("the key list is pinned", () => {
    expect(Object.keys(lensBlockCopy.en)).toEqual([
      "lens.empty.title.blocking",
      "lens.empty.title.happening",
      "lens.empty.title.produced",
      "lens.empty.title.proposed",
      "lens.empty.title.happened",
      "lens.empty.why.blocking",
      "lens.empty.why.happening",
      "lens.empty.why.produced",
      "lens.empty.why.proposed",
      "lens.empty.why.happened",
      "block.placeholder.unsupported.title",
      "block.placeholder.noAccess.title",
      "block.placeholder.failed.title",
      "block.placeholder.open",
      "block.placeholder.retry",
    ]);
  });
});
