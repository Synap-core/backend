import { describe, expect, it } from "vitest";
import {
  isCleanTitle,
  lintTitle,
  shortenTitle,
  TITLE_SOFT_MAX,
} from "./index.js";

describe("shortenTitle", () => {
  it("keeps a short line whole (one line)", () => {
    expect(shortenTitle("  Grants deny\n by default ")).toBe(
      "Grants deny by default"
    );
  });

  it("cuts at a clause boundary, never with an ellipsis", () => {
    const goal =
      "Every new title and knowledge entry is short and filed as the right kind, and this pod's existing backlog is repaired.";
    const out = shortenTitle(goal);
    expect(out).toBe(
      "Every new title and knowledge entry is short and filed as the right kind"
    );
    expect(out.length).toBeLessThanOrEqual(TITLE_SOFT_MAX);
    expect(out).not.toMatch(/…$/);
  });

  it("falls back to a word boundary and drops a dangling connector", () => {
    const text =
      "Prepare and run first client outreach for the ethical fashion pre sale venture and the brand";
    const out = shortenTitle(text, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).not.toMatch(/\s(and|the|for)$/i);
    expect(text.startsWith(out)).toBe(true);
  });

  it("strips an existing trailing ellipsis", () => {
    expect(
      shortenTitle("Relay sessions cannot follow the working state…")
    ).toBe("Relay sessions cannot follow the working state");
  });

  it("yields titles the rubric does not call cut or too long", () => {
    const samples = [
      'When a post enters "Briefed", propose running "Produce content" for that post with the brand voice',
      "SPEC BRIEF Multi-file apps on top of the Synap cell runtime, with an editor, a preview and a publish step",
      "x".repeat(300),
    ];
    for (const s of samples) {
      const out = shortenTitle(s);
      const codes = lintTitle(out).map((i) => i.code);
      expect(codes).not.toContain("too_long");
      expect(codes).not.toContain("truncated");
    }
    expect(isCleanTitle(shortenTitle(samples[0]))).toBe(true);
  });

  it("returns empty for empty input", () => {
    expect(shortenTitle("   ")).toBe("");
    expect(shortenTitle(null)).toBe("");
  });
});
