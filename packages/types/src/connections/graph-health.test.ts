import { describe, expect, it } from "vitest";
import type { ProfilePresentation } from "../presentation/index.js";
import { graphHealth } from "./graph-health.js";

const SELF = "11111111-1111-4111-8111-111111111111";
const FILE = "53fac6e4-1b6e-4464-980e-84edb4c995fd";
const USAGE =
  "Template for a quote card. File: quote-card.html (file entity 53fac6e4-1b6e-4464-980e-84edb4c995fd); previews 887fa1ec… (16:9) and 28651c37… (4:5), rendered with sample text.";
const presentation: ProfilePresentation = {
  family: "media",
  media: {
    source: { property: "asset-document-id" },
    fallbacks: [{ property: "asset-url" }],
  },
};
const properties = { "asset-usage": USAGE, "asset-status": "approved" };
const base = {
  selfId: SELF,
  presentation,
  properties,
  hasOwnDocument: false,
  linkedIds: [] as string[],
  hasFileNeighbour: false,
  textProperties: ["asset-usage"],
};

describe("graphHealth: the Quote card", () => {
  it("flags the empty slot, the prose id and both prefixes", () => {
    expect(graphHealth(base)).toEqual([
      { code: "media-source-empty", property: "asset-document-id" },
      { code: "prose-id-unlinked", value: FILE, property: "asset-usage" },
      {
        code: "prose-prefix-unresolved",
        value: "887fa1ec",
        property: "asset-usage",
      },
      {
        code: "prose-prefix-unresolved",
        value: "28651c37",
        property: "asset-usage",
      },
    ]);
  });

  it("a linked id silences the id finding alone", () => {
    expect(
      graphHealth({ ...base, linkedIds: [FILE] }).map((f) => f.code)
    ).toEqual([
      "media-source-empty",
      "prose-prefix-unresolved",
      "prose-prefix-unresolved",
    ]);
  });

  it("a file neighbour silences the media finding alone", () => {
    expect(
      graphHealth({ ...base, hasFileNeighbour: true }).map((f) => f.code)
    ).toEqual([
      "prose-id-unlinked",
      "prose-prefix-unresolved",
      "prose-prefix-unresolved",
    ]);
  });

  it("reads only textProperties that are strings", () => {
    expect(
      graphHealth({ ...base, textProperties: ["asset-status", "missing"] }).map(
        (f) => f.code
      )
    ).toEqual(["media-source-empty"]);
  });

  it("does not scan a property outside textProperties, even holding an id", () => {
    const out = graphHealth({
      ...base,
      properties: { notes: `see ${FILE} and 887fa1ec…` },
      textProperties: ["asset-usage"],
    });
    expect(out.map((f) => f.code)).toEqual(["media-source-empty"]);
  });
});

describe("graphHealth: references in prose", () => {
  const run = (text: string, linkedIds: string[] = []) =>
    graphHealth({
      selfId: SELF,
      properties: { p: text },
      hasOwnDocument: false,
      linkedIds,
      hasFileNeighbour: false,
      textProperties: ["p"],
    });
  const prefix = (value: string) => ({
    code: "prose-prefix-unresolved",
    value,
    property: "p",
  });

  it("does not flag ids inside markers or object:// references", () => {
    expect(run(`see [[entity:${FILE}|x]]`)).toEqual([]);
    expect(run(`see [[open:main|entity:${FILE}]]`)).toEqual([]);
    expect(run(`see object://${FILE}`)).toEqual([]);
  });

  it("a marker and a bare id in the same text: only the bare one is flagged", () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    expect(run(`[[entity:${FILE}|Name [x]]] and ${OTHER}`)).toEqual([
      { code: "prose-id-unlinked", value: OTHER, property: "p" },
    ]);
    expect(
      run(`[[entity:${FILE}|A]] mid ${OTHER} [[entity:${FILE}|B]]`)
    ).toEqual([{ code: "prose-id-unlinked", value: OTHER, property: "p" }]);
  });

  it("does not flag selfId or a linked id (case-insensitive, trimmed)", () => {
    expect(run(`me ${SELF.toUpperCase()}`)).toEqual([]);
    expect(run(`file ${FILE.toUpperCase()}`, [FILE])).toEqual([]);
    expect(run(`file ${FILE}`, [`  ${FILE.toUpperCase()} `])).toEqual([]);
  });

  it("does not flag a uuid glued to a word or a longer hex run", () => {
    expect(run(`x${FILE}`)).toEqual([]);
    expect(run(`${FILE}x`)).toEqual([]);
    expect(run(`a${FILE}`)).toEqual([]);
    expect(run(`${FILE}0`)).toEqual([]);
  });

  it("does not flag a bare 8-hex word without an ellipsis", () => {
    expect(run("deadbeef and 887fa1ec alone")).toEqual([]);
  });

  it("flags the prefix with three dots too", () => {
    expect(run("887fa1ec...")).toEqual([prefix("887fa1ec")]);
  });

  it("a uuid's head followed by an ellipsis is not a prefix finding", () => {
    expect(run(`${FILE}…`)).toEqual([
      { code: "prose-id-unlinked", value: FILE, property: "p" },
    ]);
    expect(run("887fa1ec-…")).toEqual([]);
  });

  it("does not flag a longer hex run before the ellipsis", () => {
    expect(run("0887fa1ec…")).toEqual([]);
  });

  it("de-duplicates case-insensitively, first property wins", () => {
    const out = graphHealth({
      selfId: SELF,
      properties: {
        a: `${FILE} 887FA1EC…`,
        b: `${FILE.toUpperCase()} 887fa1ec…`,
      },
      hasOwnDocument: false,
      linkedIds: [],
      hasFileNeighbour: false,
      textProperties: ["a", "b"],
    });
    expect(out).toEqual([
      { code: "prose-id-unlinked", value: FILE, property: "a" },
      { code: "prose-prefix-unresolved", value: "887fa1ec", property: "a" },
    ]);
  });
});

describe("graphHealth: adversarial input stays linear", () => {
  const run = (text: string) => {
    const t0 = performance.now();
    const out = graphHealth({
      selfId: SELF,
      properties: { p: text },
      hasOwnDocument: false,
      linkedIds: [],
      hasFileNeighbour: false,
      textProperties: ["p"],
    });
    return { out, ms: performance.now() - t0 };
  };

  it("an unterminated [[ repeated 50 000 times completes fast", () => {
    const { out, ms } = run("[[".repeat(50_000));
    expect(out).toEqual([]);
    expect(ms).toBeLessThan(500);
  });

  it("1 MB of mixed uuids, deadbeef, object:// and open markers completes fast", () => {
    const unit = `${FILE} deadbeef object:// [[ ${SELF.slice(0, 30)} `;
    const { ms } = run(unit.repeat(Math.ceil(1_000_000 / unit.length)));
    expect(ms).toBeLessThan(500);
  });

  it("text after an unterminated [[ is still scanned", () => {
    expect(run(`[[ open ${FILE}`).out).toEqual([
      { code: "prose-id-unlinked", value: FILE, property: "p" },
    ]);
  });
});

describe("graphHealth: a declared media source left empty", () => {
  const run = (
    pres: ProfilePresentation | null | undefined,
    extra: {
      properties?: Record<string, unknown>;
      hasOwnDocument?: boolean;
      hasFileNeighbour?: boolean;
    } = {}
  ) =>
    graphHealth({
      selfId: SELF,
      presentation: pres,
      properties: extra.properties ?? {},
      hasOwnDocument: extra.hasOwnDocument ?? false,
      linkedIds: [],
      hasFileNeighbour: extra.hasFileNeighbour ?? false,
      textProperties: [],
    });
  const empty = (property?: string) => [
    { code: "media-source-empty", property },
  ];

  it("no declaration, no finding", () => {
    expect(run({ family: "media" })).toEqual([]);
    expect(run(null)).toEqual([]);
  });

  it("a property holding a document id or an http URL yields", () => {
    expect(
      run(presentation, { properties: { "asset-document-id": FILE } })
    ).toEqual([]);
    expect(
      run(presentation, { properties: { "asset-document-id": `  ${FILE} ` } })
    ).toEqual([]);
    expect(
      run(presentation, { properties: { "asset-document-id": [FILE] } })
    ).toEqual([]);
    expect(
      run(presentation, {
        properties: { "asset-document-id": "https://x.test/a.png" },
      })
    ).toEqual([]);
  });

  it("a blank or junk property value is empty (the resolver draws nothing)", () => {
    expect(
      run(presentation, { properties: { "asset-document-id": "  " } })
    ).toEqual(empty("asset-document-id"));
    expect(
      run(presentation, { properties: { "asset-document-id": "hello" } })
    ).toEqual(empty("asset-document-id"));
  });

  it("a fallback property yields", () => {
    expect(
      run(presentation, { properties: { "asset-url": "https://x.test/a.png" } })
    ).toEqual([]);
  });

  it("a file neighbour yields", () => {
    expect(run(presentation, { hasFileNeighbour: true })).toEqual([]);
  });

  describe("{documentId: true}", () => {
    const own: ProfilePresentation = {
      family: "media",
      media: { source: { documentId: true } },
    };
    it("is empty without an own document", () => {
      expect(run(own)).toEqual([{ code: "media-source-empty" }]);
    });
    it("yields with an own document", () => {
      expect(run(own, { hasOwnDocument: true })).toEqual([]);
    });
  });

  describe("{entityRef}", () => {
    const ref: ProfilePresentation = {
      family: "media",
      media: { source: { entityRef: "file" } },
    };
    it("is empty when the property is absent", () => {
      expect(run(ref)).toEqual(empty("file"));
    });
    it("is empty when it holds a non-uuid string", () => {
      expect(run(ref, { properties: { file: "not-an-id" } })).toEqual(
        empty("file")
      );
    });
    it("yields on a uuid, padded or in a list", () => {
      expect(run(ref, { properties: { file: FILE } })).toEqual([]);
      expect(run(ref, { properties: { file: ` ${FILE} ` } })).toEqual([]);
      expect(run(ref, { properties: { file: [FILE] } })).toEqual([]);
    });
  });
});
