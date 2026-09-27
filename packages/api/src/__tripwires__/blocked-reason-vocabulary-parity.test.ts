/**
 * TRIPWIRE — every `BLOCKED_REASONS` value has a label in the vocabulary SSOT.
 *
 * The value set lives in `@synap/playbooks` (next to the `ExpectedOutput`
 * interface that carries it). The labels live in `@synap-core/types/vocabulary`
 * (the ONE door for turning a domain token into a human word). Neither package
 * may depend on the other — playbooks is dependency-free, types is the shared
 * leaf — so the two are kept in lock-step HERE, in `@synap/api`, the first
 * package that depends on both.
 *
 * Without this, adding a seventh blocker gives users a `humanizeToken` fallback
 * that reads plausibly ("Quota") while nobody notices the label was never
 * written. That is how a label map forks: not by disagreeing, but by one side
 * quietly falling back.
 */
import { describe, it, expect } from "vitest";
import { BLOCKED_REASONS } from "@synap/playbooks";
import {
  BLOCKED_REASON_FALLBACK_ICON,
  BLOCKED_REASON_ICONS,
  BLOCKED_REASON_LABELS,
  resolveBlockedReasonIcon,
  resolveBlockedReasonLabel,
  humanizeToken,
} from "@synap-core/types/vocabulary";

describe("blockedReason ↔ vocabulary parity", () => {
  it("gives every blocker an EXPLICIT label, never the humanize fallback", () => {
    const fellBack = BLOCKED_REASONS.filter(
      (r) => resolveBlockedReasonLabel(r) === humanizeToken(r)
    );
    expect(fellBack).toEqual([]);
  });

  it("has no label for a value that is not in the closed set", () => {
    const known = new Set<string>(BLOCKED_REASONS);
    const orphans = Object.keys(BLOCKED_REASON_LABELS).filter(
      (k) => !known.has(k)
    );
    expect(orphans).toEqual([]);
  });

  // The GLYPH is the other half of the mark (label + glyph, never tone). A
  // blocker without a row draws the fallback "?" — the same quiet fork the
  // label check above exists to catch.
  it("gives every blocker an EXPLICIT glyph, never the fallback mark", () => {
    const fellBack = BLOCKED_REASONS.filter(
      (r) => resolveBlockedReasonIcon(r) === BLOCKED_REASON_FALLBACK_ICON
    );
    expect(fellBack).toEqual([]);
    // Non-vacuity: the resolver still reaches the fallback for a stray value.
    expect(resolveBlockedReasonIcon("not-a-blocker")).toBe(
      BLOCKED_REASON_FALLBACK_ICON
    );
  });

  it("has no glyph for a value that is not in the closed set", () => {
    const known = new Set<string>(BLOCKED_REASONS);
    const orphans = Object.keys(BLOCKED_REASON_ICONS).filter(
      (k) => !known.has(k)
    );
    expect(orphans).toEqual([]);
  });
});
