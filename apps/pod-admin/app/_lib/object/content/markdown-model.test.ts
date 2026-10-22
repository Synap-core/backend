import { describe, expect, it } from "vitest";
import {
  CONTENT_PARSE_LIMIT,
  contentHref,
  entityEmbedRead,
  EXTERNAL_REL,
  objectKindForMarker,
  objectPage,
  prepareContent,
  UNPARSED_PREVIEW_CHARS,
} from "./markdown-model";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("prepareContent", () => {
  it("draws a short body whole", () => {
    expect(prepareContent("# Hi\n\nThere.", "markdown")).toEqual({
      format: "markdown",
      text: "# Hi\n\nThere.",
      truncated: false,
      shownPercent: 100,
    });
  });

  it("cuts long markdown at a block boundary, never mid-paragraph", () => {
    const para = (n: number) => `Paragraph ${n} ${"word ".repeat(18)}`.trim();
    const source = Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n");
    const out = prepareContent(source, "markdown", { maxChars: 350 });
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(350);
    expect(source.startsWith(out.text)).toBe(true);
    // Every drawn block is a whole paragraph of the source.
    for (const block of out.text.split("\n\n")) {
      expect(source.split("\n\n")).toContain(block);
    }
    expect(out.shownPercent).toBeGreaterThan(0);
    expect(out.shownPercent).toBeLessThan(100);
  });

  it("keeps a code fence whole across its blank lines", () => {
    const fence = "```\nline one\n\nline two\n```";
    const source = `${fence}\n\n${"Tail. ".repeat(40)}`;
    const out = prepareContent(source, "markdown", {
      maxChars: fence.length + 5,
    });
    expect(out.text).toBe(fence);
    expect(out.truncated).toBe(true);
  });

  it("still shows something when the first block alone is too long", () => {
    const source = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const out = prepareContent(source, "markdown", { maxChars: 40 });
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThanOrEqual(40);
    expect(out.text.endsWith("\n")).toBe(false);
  });

  it("cuts plain text at a line", () => {
    const source = "alpha\nbravo\ncharlie\ndelta";
    expect(prepareContent(source, "text", { maxChars: 14 }).text).toBe(
      "alpha\nbravo"
    );
  });

  it("does not parse a body past the parse limit: a plain preview instead", () => {
    const line = "x".repeat(99) + "\n";
    const source = line.repeat(Math.ceil(CONTENT_PARSE_LIMIT / 100) + 10);
    const out = prepareContent(source, "markdown");
    expect(out.format).toBe("source");
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(UNPARSED_PREVIEW_CHARS);
    expect(out.shownPercent).toBe(1);
  });
});

describe("contentHref", () => {
  it("follows http, https and mailto, and says how to open them", () => {
    expect(contentHref("https://example.com/a?b=1")).toEqual({
      kind: "external",
      href: "https://example.com/a?b=1",
    });
    expect(contentHref("http://example.com").kind).toBe("external");
    expect(contentHref("mailto:ana@example.com").kind).toBe("external");
    expect(EXTERNAL_REL.split(" ").sort()).toEqual([
      "nofollow",
      "noopener",
      "noreferrer",
    ]);
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "javascript://comment%0aalert(1)",
    "/relative/path",
    "#anchor",
    "ftp://example.com/file",
    "https://user:pass@example.com",
    "",
    null,
  ])("never follows %s", (url) => {
    expect(contentHref(url)).toEqual({ kind: "none" });
  });

  it("never draws a raw synap:// link", () => {
    expect(contentHref(`synap://open/entity/${UUID}`)).toEqual({
      kind: "none",
    });
  });

  it("sends an object marker to its console page", () => {
    expect(contentHref(`entity://${UUID}`)).toEqual({
      kind: "internal",
      href: `/open/entity/${UUID}`,
    });
    expect(contentHref(`doc://${UUID}`)).toEqual({
      kind: "internal",
      href: `/open/document/${UUID}`,
    });
    expect(contentHref(`view://${UUID}`).kind).toBe("internal");
  });

  it("a kind the web does not host lands on its named card, not on synap://", () => {
    expect(contentHref(`project://${UUID}`)).toEqual({
      kind: "internal",
      href: `/open/project/${UUID}`,
    });
  });

  it("refuses a marker with a bad id or an unknown kind", () => {
    expect(contentHref("entity://not-a-uuid")).toEqual({ kind: "none" });
    expect(contentHref(`spaceship://${UUID}`)).toEqual({ kind: "none" });
  });

  it("never performs an action marker", () => {
    expect(contentHref(`run://${UUID}`)).toEqual({ kind: "none" });
    expect(contentHref(`open://side/entity/${UUID}`)).toEqual({
      kind: "none",
    });
  });
});

describe("objectKindForMarker", () => {
  it("maps marker words onto open kinds", () => {
    expect(objectKindForMarker("doc")).toBe("document");
    expect(objectKindForMarker("person")).toBe("entity");
    expect(objectKindForMarker("widget")).toBe("cell");
    expect(objectKindForMarker("Entity")).toBe("entity");
  });
});

describe("objectPage — where an object a page names opens", () => {
  it("hosted kinds and proposals open on their own console page", () => {
    expect(objectPage("document", UUID)).toBe(`/open/document/${UUID}`);
    expect(objectPage("channel", UUID)).toBe(`/open/channel/${UUID}`);
    expect(objectPage("proposal", UUID)).toBe(`/proposal/${UUID}`);
  });

  it("an app-only kind opens its named card; an unknown kind opens nothing", () => {
    expect(objectPage("cell", "chart-bar")).toBe("/open/cell/chart-bar");
    expect(objectPage("url", "https://example.com")).toBeNull();
    expect(objectPage("entity", "../../admin")).toBeNull();
  });
});

describe("entityEmbedRead — what an embedded record may say", () => {
  const q = (over: Partial<Parameters<typeof entityEmbedRead>[0]>) =>
    entityEmbedRead({ isLoading: false, error: null, data: undefined, ...over });

  it("a record the reader can see gives its title", () => {
    expect(q({ data: { entity: { title: "  Ana  " } } })).toEqual({
      state: "ready",
      title: "Ana",
    });
    expect(q({ data: { entity: { title: "" } } })).toEqual({
      state: "ready",
      title: "Untitled",
    });
  });

  it("not found / forbidden / a bad id are hidden — never a title", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "BAD_REQUEST", "UNAUTHORIZED"]) {
      expect(q({ error: { data: { code } } })).toEqual({ state: "hidden" });
    }
  });

  it("a broken read is failed and retryable, not hidden", () => {
    const retry = () => {};
    expect(q({ error: { data: { code: "INTERNAL_SERVER_ERROR" } }, retry })).toEqual({
      state: "failed",
      retry,
    });
    expect(q({ error: {} }).state).toBe("failed");
  });

  it("an error wins over loading; loading wins over data", () => {
    expect(q({ isLoading: true, error: { data: { code: "NOT_FOUND" } } }).state).toBe(
      "hidden"
    );
    expect(q({ isLoading: true }).state).toBe("loading");
  });
});
