/**
 * A choose option may carry a media ref (image | video | audio) the person
 * sees before picking. Additive: an option without it parses as before.
 */
import { describe, expect, it } from "vitest";
import { AskSchema } from "./index.js";
import { askOptionChips, followUpChips } from "./card.js";

const A1 = "00000000-0000-4000-8000-0000000000a1";
const E1 = "00000000-0000-4000-8000-0000000000e1";

const ask = (media: unknown) => ({
  mode: "choose",
  options: [{ label: "Take 2", media }, { label: "Take 3" }],
});

describe("ask option media", () => {
  it("keeps each ref shape through the parse and the chip", () => {
    for (const ref of [
      { url: "https://example.com/t2.mp4" },
      { assetId: A1 },
      { entityId: E1 },
    ]) {
      const media = { kind: "video", ref, alt: "wide shot" };
      const parsed = AskSchema.parse(ask(media));
      const chips = askOptionChips(parsed);
      expect(chips[0]!.media).toEqual(media);
      expect(chips[1]!.media).toBeUndefined();
    }
  });

  it("rides a follow-up option too", () => {
    const parsed = AskSchema.parse({
      mode: "choose",
      options: [
        {
          label: "Shots",
          followUp: {
            prompt: "Which?",
            options: [
              { label: "A", media: { kind: "image", ref: { assetId: A1 } } },
              { label: "B" },
            ],
          },
        },
      ],
    });
    const first = parsed.mode === "choose" ? parsed.options[0]! : null;
    expect(followUpChips(first!)[0]!.media?.kind).toBe("image");
  });

  it("refuses a bad kind, an empty ref, two refs and a non-url", () => {
    const bad = (m: unknown) => AskSchema.safeParse(ask(m)).success;
    expect(bad({ kind: "gif", ref: { url: "https://a.b" } })).toBe(false);
    expect(bad({ kind: "image", ref: {} })).toBe(false);
    expect(
      bad({ kind: "image", ref: { url: "https://a.b", assetId: "x" } })
    ).toBe(false);
    expect(bad({ kind: "image", ref: { url: "nope" } })).toBe(false);
  });

  it("refuses a script-capable or local url scheme", () => {
    const bad = (url: string) =>
      AskSchema.safeParse(ask({ kind: "image", ref: { url } })).success;
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://a.b/x.png",
      "blob:https://a.b/1",
    ]) {
      expect(bad(url), url).toBe(false);
    }
    expect(bad("HTTPS://a.b/x.png")).toBe(true);
    expect(bad("http://a.b/x.png")).toBe(true);
  });

  it("refuses an asset or entity ref that is not an id", () => {
    const bad = (ref: unknown) =>
      AskSchema.safeParse(ask({ kind: "image", ref })).success;
    expect(bad({ assetId: "a-1" })).toBe(false);
    expect(bad({ entityId: "../../etc" })).toBe(false);
    expect(bad({ assetId: A1 })).toBe(true);
  });
});
