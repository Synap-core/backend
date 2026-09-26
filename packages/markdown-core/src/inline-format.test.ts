/**
 * v2 V1 inline formatting: `:u[…]`, `:color[…]{tone}`, `==…=={tone}`.
 *
 * Reader (micromark → `remarkInlineFormat` / `remarkHighlight`) and the
 * editor's source scanners (`readInlineFormatAt` / `readHighlightAt`) are held
 * to the SAME answers over one corpus; prose that merely contains a colon is
 * never formatting.
 */
import { describe, expect, it } from "vitest";
import { parseMarkdown, parseMarkdownWithDiagnostics } from "./processor.js";
import { collectDiagnostics } from "./diagnostics.js";
import { markdownToPlainText } from "./plain-text.js";
import { readableMarkdown } from "./readable.js";
import {
  readHighlightAt,
  readInlineFormatAt,
  serializeHighlight,
  serializeTextColor,
  serializeUnderline,
  TEXT_TONES,
} from "./inline-format.js";

type N = {
  type: string;
  value?: string;
  tone?: string | null;
  url?: string;
  children?: N[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const text = (n: N): string =>
  (n.value ?? "") + (n.children ?? []).map(text).join("");

/** Every formatting node: `kind(tone):words`. */
function formats(md: string): string[] {
  const out: string[] = [];
  const walk = (n: N) => {
    if (n.type === "underline") out.push(`u:${text(n)}`);
    if (n.type === "textColor") out.push(`color(${n.tone}):${text(n)}`);
    if (n.type === "mark") out.push(`mark(${n.tone ?? ""}):${text(n)}`);
    (n.children ?? []).forEach(walk);
  };
  walk(parseMarkdown(md) as unknown as N);
  return out;
}

describe("reading the three forms", () => {
  it(":u[x] is an underline drawn as <u>", () => {
    const para = (parseMarkdown("an :u[under] word") as unknown as N)
      .children![0]!;
    expect(para.children!.map((c) => c.type)).toEqual([
      "text",
      "underline",
      "text",
    ]);
    expect(para.children![1]!.data?.hName).toBe("u");
  });

  it(":color[x]{tone=t} is a textColor carrying the tone, drawn as a toned <span>", () => {
    const node = (parseMarkdown(":color[x]{tone=info}") as unknown as N)
      .children![0]!.children![0]!;
    expect(node).toMatchObject({
      type: "textColor",
      tone: "info",
      data: {
        hName: "span",
        hProperties: {
          className: ["synap-text-tone", "synap-text-tone--info"],
          "data-tone": "info",
        },
      },
    });
  });

  it("==x=={tone=t} is the SAME mark with a tone; ==x== keeps no tone", () => {
    expect(formats("==a== and ==b=={tone=success}")).toEqual([
      "mark():a",
      "mark(success):b",
    ]);
    const toned = (parseMarkdown("==b=={tone=success}") as unknown as N)
      .children![0]!.children![0]!;
    expect(toned.data?.hProperties).toEqual({
      className: ["synap-mark", "synap-mark--success"],
      "data-tone": "success",
    });
  });

  it("nests with bold, links and each other", () => {
    expect(
      formats(
        "**:u[bold under]** :color[a **b** [l](https://x.test)]{tone=error} :u[:color[both]{tone=warning}] ==:u[hl]=={tone=primary}"
      )
    ).toEqual([
      "u:bold under",
      "color(error):a b l",
      "u:both",
      "color(warning):both",
      "mark(primary):hl",
      "u:hl",
    ]);
    const link = (
      parseMarkdown(":color[[l](https://x.test/a)]{tone=info}") as unknown as N
    ).children![0]!.children![0]!.children![0]!;
    expect(link).toMatchObject({ type: "link", url: "https://x.test/a" });
  });

  it("every allowed tone is accepted", () => {
    for (const tone of TEXT_TONES)
      expect(formats(`:color[x]{tone=${tone}}`)).toEqual([`color(${tone}):x`]);
  });
});

describe("prose stays prose (the prose-directive restore lesson)", () => {
  const PROSE: Record<string, string> = {
    time: "time: 10:30 sharp",
    ratio: "ratio 3:1 and ratio:high",
    "a URL holding :u": "see https://x.test/a:u[b] ok",
    "an autolink holding :u": "<https://x.test/:u[z]>",
    "inline code": "`:u[x]` and `:color[x]{tone=info}`",
    "fenced code": "```\n:u[x]\n==y=={tone=info}\n```",
    "empty label": "an :u[] here",
    "no label": "a :u and :color{tone=info} here",
    "uppercase name": "x :U[y]",
    "u with an attribute": ":u[x]{tone=info}",
    "color with another attribute": ':color[x]{tone="info" class=y}',
    "an escaped colon": "a \\:u[x]",
    "a spaced ==": "a == b == c{tone=info}",
  };
  for (const [name, md] of Object.entries(PROSE)) {
    it(`${name}: no formatting, words intact`, () => {
      expect(formats(md).filter((f) => !f.startsWith("mark():"))).toEqual([]);
    });
  }

  it("the colon survives in the text", () => {
    expect(markdownToPlainText("time: 10:30, ratio 3:1")).toBe(
      "time: 10:30, ratio 3:1"
    );
    expect(markdownToPlainText(":u[x]{tone=info}")).toBe(":u[x]{tone=info}");
  });
});

describe("unknown tone: kept, drawn plain, diagnosed", () => {
  it("text colour", () => {
    const node = (parseMarkdown(":color[x]{tone=purple}") as unknown as N)
      .children![0]!.children![0]!;
    expect(node.tone).toBe("purple");
    expect(node.data?.hProperties).toEqual({ className: ["synap-text-tone"] });
    expect(collectDiagnostics("ok\n\n:color[x]{tone=purple}")).toEqual([
      expect.objectContaining({ code: "unknown-tone", line: 3 }),
    ]);
  });

  it("a colour with no tone", () => {
    expect(formats(":color[x]")).toEqual(["color(null):x"]);
    expect(collectDiagnostics(":color[x]").map((d) => d.code)).toEqual([
      "unknown-tone",
    ]);
  });

  it("the withheld ai tone is unknown to a document", () => {
    expect(collectDiagnostics(":color[x]{tone=ai}").map((d) => d.code)).toEqual(
      ["unknown-tone"]
    );
  });

  it("highlight", () => {
    const { diagnostics } = parseMarkdownWithDiagnostics(
      "a\n\nb ==x=={tone=purple}"
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "unknown-tone", line: 3 }),
    ]);
    expect(formats("==x=={tone=purple}")).toEqual(["mark(purple):x"]);
  });

  it("known tones raise nothing", () => {
    expect(
      collectDiagnostics(":u[a] :color[b]{tone=info} ==c=={tone=error} ==d==")
    ).toEqual([]);
  });
});

describe("plain text, readable export", () => {
  const MD =
    "An :u[under **bold**] word, :color[tinted]{tone=info}, ==hl=={tone=success} and ==plain==.";

  it("plain text keeps the words only", () => {
    expect(markdownToPlainText(MD)).toBe(
      "An under bold word, tinted, hl and plain."
    );
  });

  it("readable keeps the label's markdown and drops the Synap syntax", () => {
    expect(readableMarkdown(MD, () => "x")).toBe(
      "An under **bold** word, tinted, ==hl== and ==plain==."
    );
  });

  it("readable composes nesting, and leaves code alone", () => {
    expect(
      readableMarkdown(
        ":u[:color[both]{tone=info}] `:u[code]` ==a=={tone=info}b",
        () => "x"
      )
    ).toBe("both `:u[code]` ==a==b");
  });
});

describe("writers: one per construct, byte-stable", () => {
  it("write the canonical forms", () => {
    expect(serializeUnderline("x")).toBe(":u[x]");
    expect(serializeTextColor("x", "info")).toBe(":color[x]{tone=info}");
    expect(serializeTextColor("x", null)).toBe(":color[x]");
    expect(serializeHighlight("x")).toBe("==x==");
    expect(serializeHighlight("x", "error")).toBe("==x=={tone=error}");
    expect(serializeTextColor("x", "not a tone")).toBe(
      ':color[x]{tone="not a tone"}'
    );
  });

  it("an unbalanced bracket in the label is escaped; a link is not", () => {
    expect(serializeUnderline("a]b")).toBe(":u[a\\]b]");
    expect(formats(serializeUnderline("a]b"))).toEqual(["u:a]b"]);
    expect(serializeUnderline("[l](u)")).toBe(":u[[l](u)]");
  });

  it("scanner → writer is the identity on canonical sources", () => {
    for (const src of [
      ":u[x]",
      ":u[a **b** [l](https://x.test)]",
      ":color[x]{tone=info}",
      ":color[a\\]b]{tone=textMuted}",
    ]) {
      const m = readInlineFormatAt(src)!;
      const back =
        m.kind === "underline"
          ? serializeUnderline(m.label)
          : serializeTextColor(m.label, m.tone);
      expect(back).toBe(src);
    }
    for (const src of ["==x==", "==a b=={tone=warning}"]) {
      const m = readHighlightAt(src)!;
      expect(serializeHighlight(m.inner, m.tone)).toBe(src);
    }
  });
});

// ─── Conformance: the editor's scanners agree with micromark ────────────────

/** Formatting spans the READER found, as `kind(tone)@start-end`. */
function readerSpans(md: string): string[] {
  const out: string[] = [];
  const walk = (n: N) => {
    const s = n.position?.start.offset;
    const e = n.position?.end.offset;
    if ((n.type === "underline" || n.type === "textColor") && s != null)
      out.push(
        `${n.type === "underline" ? "u" : `color(${n.tone})`}@${s}-${e}`
      );
    (n.children ?? []).forEach(walk);
  };
  walk(parseMarkdown(md) as unknown as N);
  return out.sort();
}

/** The same spans found by scanning the source left to right. */
function scannerSpans(md: string): string[] {
  const out: string[] = [];
  const scan = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (md[i] === "\\") {
        i++;
        continue;
      }
      if (md[i] !== ":") continue;
      const m = readInlineFormatAt(md.slice(i, to), i > from ? md[i - 1] : "");
      if (!m) continue;
      out.push(
        `${m.kind === "underline" ? "u" : `color(${m.tone})`}@${i}-${i + m.raw.length}`
      );
      const labelStart = i + m.raw.indexOf("[") + 1;
      scan(labelStart, labelStart + m.label.length);
      i += m.raw.length - 1;
    }
  };
  scan(0, md.length);
  return out.sort();
}

function highlightTones(md: string): string[] {
  return formats(md)
    .filter((f) => f.startsWith("mark"))
    .map((f) => f.replace(/:.*$/, ""));
}
function scannedHighlightTones(md: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < md.length; i++) {
    if (md[i] !== "=") continue;
    const m = readHighlightAt(md.slice(i), md[i - 1] ?? "");
    if (!m) continue;
    out.push(`mark(${m.tone ?? ""})`);
    i += m.raw.length - 1;
  }
  return out;
}

const CORPUS = [
  "plain words",
  "an :u[under] word",
  "word:u[intra]word",
  ":color[x]{tone=info} and :color[y]{ tone = error }",
  ':color[x]{tone="textMuted"}',
  ":u[x]{}",
  ":u[x]{a=b} stays prose",
  ':color[x]{tone="info" class=y} stays prose',
  ":u[] :U[x] :u stays prose",
  ":u[a [b] c]",
  ":u[a\\]b]",
  ":u[a]b] unbalanced closes early",
  "**:u[bold]** and *:color[em]{tone=primary}*",
  ":u[:color[nested]{tone=success}]",
  ":u[x",
  "time: 10:30 ratio 3:1 ratio:high",
  ":color[x]{tone=purple}",
  "==a== ==b=={tone=info} ==c=={ tone = error } ==d=={tone=nope}",
  "a == b == c",
  "==x=={tone=info}{tone=error}",
  "x ==a **b** c=={tone=warning} y",
  "==**b**== and ==:u[x]=={tone=info}",
  "x ==**b** no closer",
  "a::u[x] and a :::u[y] b",
  "===x== y and x===x==",
];

describe("conformance: reader ⇔ editor scanner", () => {
  for (const md of CORPUS) {
    it(`agrees on ${JSON.stringify(md)}`, () => {
      expect(scannerSpans(md)).toEqual(readerSpans(md));
      expect(scannedHighlightTones(md)).toEqual(highlightTones(md));
    });
  }

  it("non-vacuous: the corpus holds every kind, and prose", () => {
    const all = CORPUS.flatMap(readerSpans).join(" ");
    expect(all).toMatch(/\bu@/);
    expect(all).toMatch(/color\(info\)@/);
    expect(all).toMatch(/color\(purple\)@/);
    expect(CORPUS.flatMap(highlightTones)).toEqual(
      expect.arrayContaining(["mark()", "mark(info)", "mark(nope)"])
    );
    expect(CORPUS.filter((md) => readerSpans(md).length === 0).length).toBe(
      CORPUS.filter((md) => scannerSpans(md).length === 0).length
    );
  });
});
