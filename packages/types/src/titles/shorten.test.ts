import { describe, expect, it } from "vitest";
import {
  isCleanTitle,
  lintTitle,
  shortenTitle,
  TITLE_SOFT_MAX,
} from "./index.js";

describe("shortenTitle", () => {
  it("keeps a short line whole", () => {
    expect(shortenTitle("  Grants deny   by default ")).toBe(
      "Grants deny by default"
    );
  });

  it("names a multi-line text from its first line, never the whole body", () => {
    expect(
      shortenTitle(
        "Grants deny by default\nThe resolver never returns null.\nSee the plan."
      )
    ).toBe("Grants deny by default");
    // A blank or marker-only first line is skipped.
    expect(shortenTitle("\n\n  \n- \nCall Alice about the lease\n")).toBe(
      "Call Alice about the lease"
    );
  });

  it("strips markdown markers, links and bare URLs", () => {
    expect(shortenTitle("## **Grants** deny by `default`")).toBe(
      "Grants deny by default"
    );
    expect(shortenTitle("- [ ] Send the *signed* agreement")).toBe(
      "Send the signed agreement"
    );
    expect(
      shortenTitle("Read [the lens doc](https://synap.live/docs/lens) today")
    ).toBe("Read the lens doc today");
    expect(
      shortenTitle("https://example.com/a/b?c=1 great article on lenses")
    ).toBe("great article on lenses");
    expect(shortenTitle("> quoted [[document:abc|Plan]] note")).toBe(
      "quoted Plan note"
    );
    // snake_case and arithmetic are not markdown.
    expect(shortenTitle("key_revoked means 2 * 3 signals")).toBe(
      "key_revoked means 2 * 3 signals"
    );
  });

  it("names a links-only text after its host", () => {
    expect(shortenTitle("https://www.example.com/article?id=3")).toBe(
      "example.com"
    );
    expect(shortenTitle("https://a.io/x\nhttps://b.io/y")).toBe("a.io");
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

  it("strips a repeated or spaced trailing ellipsis, never adds one", () => {
    expect(shortenTitle("Relay sessions cannot follow … …")).toBe(
      "Relay sessions cannot follow"
    );
    expect(shortenTitle("Relay sessions cannot follow.....")).toBe(
      "Relay sessions cannot follow"
    );
    const long = "word ".repeat(60) + "…";
    expect(shortenTitle(long)).not.toMatch(/(…|\.\.\.)$/);
  });

  it("never splits an emoji, a ZWJ family or a combining mark", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const text = "x".repeat(19) + family + "y".repeat(30);
    const out = shortenTitle(text, 20);
    // The cut lands before the family, never inside it.
    expect(out).toBe("x".repeat(19));
    const accents = "e\u0301".repeat(30); // é as e + combining acute
    const cut = shortenTitle(accents, 21);
    expect(cut.length).toBeLessThanOrEqual(21);
    expect(cut.endsWith("e")).toBe(false);
    expect(cut.normalize("NFC")).toBe("\u00e9".repeat(cut.length / 2));
    // A lone surrogate is never produced.
    const emoji = "\u{1F680}".repeat(50);
    expect(shortenTitle(emoji, 21)).toBe("\u{1F680}".repeat(10));
  });

  it("keeps graphemes whole on a runtime without Intl.Segmenter (Hermes)", () => {
    const intl = Intl as unknown as { Segmenter?: unknown };
    const saved = intl.Segmenter;
    intl.Segmenter = undefined;
    try {
      const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
      expect(shortenTitle("x".repeat(19) + family + "y".repeat(30), 20)).toBe(
        "x".repeat(19)
      );
      expect(shortenTitle("\u{1F680}".repeat(50), 21)).toBe(
        "\u{1F680}".repeat(10)
      );
      const cut = shortenTitle("e\u0301".repeat(30), 21);
      expect(cut.endsWith("e")).toBe(false);
    } finally {
      intl.Segmenter = saved;
    }
  });

  it("cuts CJK at a word or grapheme boundary within the budget", () => {
    const cjk = "東京都の新しい図書館は来年の春に開館する予定です".repeat(4);
    const out = shortenTitle(cjk, 20);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(cjk.startsWith(out)).toBe(true);
    expect(out).not.toMatch(/…$/);
  });

  it("returns empty for empty input", () => {
    expect(shortenTitle("   ")).toBe("");
    expect(shortenTitle(null)).toBe("");
  });
});
