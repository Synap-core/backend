import { describe, expect, it } from "vitest";
import {
  findObjectIds,
  linkObjectIds,
  markdownToPlainText,
  parseMarkdown,
  resolvePatternMarkers,
} from "./index.js";

const ID = "3f2a91c4-7b10-4e55-9c02-8ad1f6e4b2d7";
const ID2 = "9cf761cd-420f-40cd-ab1d-c5a9edd95e14";

interface Loose {
  type: string;
  value?: string;
  url?: string;
  children?: Loose[];
}

/** Every node of a type, however deep. */
function all(tree: unknown, type: string, out: Loose[] = []): Loose[] {
  const n = tree as Loose;
  if (n.type === type) out.push(n);
  for (const c of n.children ?? []) all(c, type, out);
  return out;
}
const refs = (md: string) =>
  all(linkObjectIds(parseMarkdown(md)), "link")
    .filter((l) => l.url?.startsWith("object://"))
    .map((l) => ({ url: l.url, words: (l.children ?? []).length }));
/** The prose a reader of the linked tree still has, ids as chips removed. */
const texts = (md: string) =>
  all(linkObjectIds(parseMarkdown(md)), "text")
    .map((t) => t.value)
    .join("|");

describe("a bare id in prose becomes an unlabelled object reference", () => {
  it("one id: the words around it stay, the id is an object:// link with no words", () => {
    expect(refs(`Blocked by ${ID} since Monday.`)).toEqual([
      { url: `object://${ID}`, words: 0 },
    ]);
    expect(texts(`Blocked by ${ID} since Monday.`)).toBe(
      "Blocked by | since Monday."
    );
  });

  it("several ids, at the start and the end, in headings, lists, tables and highlights", () => {
    const md = [
      `${ID} first`,
      "",
      `## About ${ID2}`,
      "",
      `- see ${ID}`,
      "",
      `| a | b |`,
      `|---|---|`,
      `| ${ID2} | x |`,
      "",
      `A ==${ID}== word, then ${ID2}.`,
    ].join("\n");
    expect(refs(md).map((r) => r.url)).toEqual([
      `object://${ID}`,
      `object://${ID2}`,
      `object://${ID}`,
      `object://${ID2}`,
      `object://${ID}`,
      `object://${ID2}`,
    ]);
  });

  it("an id written in capitals is still an id", () => {
    expect(refs(`See ${ID.toUpperCase()}.`)).toEqual([
      { url: `object://${ID.toUpperCase()}`, words: 0 },
    ]);
  });

  it("prose inside a section frame is prose", () => {
    const md = `::::synap-section{id="s1"}\n## Status\n\nOwned by ${ID}.\n::::`;
    expect(refs(md).map((r) => r.url)).toEqual([`object://${ID}`]);
  });
});

describe("what is never rewritten", () => {
  it("code, inline code, math and a raw HTML block keep the id as written", () => {
    expect(refs("```\nget " + ID + "\n```")).toEqual([]);
    expect(refs("Run `get " + ID + "`.")).toEqual([]);
    expect(refs(`<div>\n${ID}\n</div>`)).toEqual([]);
    expect(refs(`$$\n${ID}\n$$`)).toEqual([]);
  });

  it("between inline tags the id is prose (the tags draw as text, the id as a chip)", () => {
    // mdast splits `<span>id</span>` into html, text, html: the reader sees
    // the tags as literal text and the id in the sentence.
    expect(refs(`<span>${ID}</span>`)).toEqual([
      { url: `object://${ID}`, words: 0 },
    ]);
  });

  it("a marker's id is the marker's: written by the author, or still in the text (native)", () => {
    // Web and pod admin rewrite markers to links before the parse…
    const md = `See [[entity:${ID}|Ana]] and [[doc:${ID2}]].`;
    expect(refs(resolvePatternMarkers(md))).toEqual([]);
    // …native renders keep them in the text and split them at draw time.
    expect(refs(md)).toEqual([]);
    expect(texts(md)).toBe(md);
  });

  it("a link's own words and address, an image, an autolink", () => {
    expect(refs(`[the plan ${ID}](https://x.example/${ID2})`)).toEqual([]);
    expect(refs(`![chart ${ID}](https://x.example/a.png)`)).toEqual([]);
    expect(refs(`https://pod.example/open/${ID}`)).toEqual([]);
  });

  it("an id that is part of a path, a query, an address or a longer token", () => {
    for (const s of [
      `/open/${ID}`,
      `open/${ID}/edit`,
      `?id=${ID}`,
      `#${ID}`,
      `user@${ID}`,
      `${ID}-v2`,
      `x${ID}`,
      `entity:${ID}`,
    ]) {
      expect(refs(`Look at ${s} now.`), s).toEqual([]);
    }
  });

  it("not an id: wrong length or not hex", () => {
    expect(refs("3f2a91c4-7b10-4e55-9c02-8ad1f6e4b2d")).toEqual([]);
    expect(refs("zf2a91c4-7b10-4e55-9c02-8ad1f6e4b2d7")).toEqual([]);
  });
});

describe("only renderers see the chip", () => {
  it("plain text keeps the id: an agent or a search reads it as written", () => {
    expect(markdownToPlainText(`Blocked by ${ID}.`)).toContain(ID);
  });

  it("the shared parse alone does not rewrite (the transform is opt-in)", () => {
    expect(all(parseMarkdown(`Blocked by ${ID}.`), "link")).toEqual([]);
  });
});

describe("findObjectIds — the one rule", () => {
  it("names each id and where it starts, skipping markers", () => {
    const text = `[[entity:${ID}|Ana]] owns ${ID2}.`;
    expect(findObjectIds(text)).toEqual([
      { id: ID2, index: text.indexOf(ID2) },
    ]);
  });
});
