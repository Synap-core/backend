import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentChanges, TextDiff } from "./document-changes";
import { documentChanges, textChanges } from "./document-changes-model";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const change = (before: string, after: string) => ({
  before,
  after,
  lines: textChanges(before, after),
});

describe("TextDiff — the whole text, its changes in place", () => {
  const paragraphs = ["One.", "Two.", "Three.", "Four.", "Five.", "Six."];
  const before = [...paragraphs, "Ship on Monday."].join("\n\n");
  const after = [...paragraphs, "Ship on Friday."].join("\n\n");

  it("opens on the Changes reading: the edit word by word, the far unchanged text folded", () => {
    const out = html(<TextDiff change={change(before, after)} title="Plan" />);
    expect(out).toContain("Plan");
    expect(out).toContain('aria-label="Read this change as"');
    // The edit, word by word.
    expect(out).toMatch(/<del[^>]*>.*Monday\.<\/del>/);
    expect(out).toMatch(/<ins[^>]*>.*Friday\.<\/ins>/);
    // Five unchanged paragraphs far from the change fold; the one beside it stays.
    expect(out).toContain("Show 5 unchanged paragraphs");
    // How much changed, as a mark.
    expect(out).toContain("+1");
    expect(out).toContain("−1");
  });

  it("reads code as source only: numbered lines, no rendered reading to switch to", () => {
    const out = html(
      <TextDiff
        code
        change={{
          before: "a\nreturn 1;\nc",
          after: "a\nreturn 2;\nc",
          lines: [],
        }}
      />
    );
    expect(out).toContain("data-line-diff");
    expect(out).not.toContain('aria-label="Read this change as"');
    expect(out).toMatch(/<del[^>]*>.*1;<\/del>/);
    expect(out).toMatch(/<ins[^>]*>.*2;<\/ins>/);
    // Both sides' line numbers.
    expect(out).toMatch(/>2<\/td><td[^>]*><\/td>/);
    expect(out).toMatch(/><\/td><td[^>]*>2<\/td>/);
  });
});

describe("DocumentChanges — a document edit, one diff per section it touches", () => {
  it("titles each section and draws its change", () => {
    const changes = documentChanges({
      preview: [
        {
          sectionId: "plan",
          title: "Plan",
          before: "Intro.\n\nShip on Monday.",
          after: "Intro.\n\nShip on Friday.",
        },
      ],
    })!;
    const out = html(<DocumentChanges changes={changes} />);
    expect(out).toContain("Plan");
    expect(out).toContain("data-text-diff");
    expect(out).toMatch(/<ins[^>]*>.*Friday\.<\/ins>/);
  });
});
