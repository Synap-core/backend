import { describe, expect, it } from "vitest";
import { documentContent, documentFormat } from "./document-model";

const err = (code: string) => ({ data: { code } });
const md = (content: string, type = "markdown") => ({
  document: { type, storageKey: "k", storageUrl: null },
  content,
});

describe("documentContent — the viewer's own floor", () => {
  it("a document the member cannot read shows no content at all", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN"]) {
      const out = documentContent(err(code), undefined);
      expect(out).toEqual({ kind: "hidden" });
    }
  });

  it("hidden wins even if a stale answer is still around", () => {
    expect(documentContent(err("NOT_FOUND"), md("secret plans"))).toEqual({
      kind: "hidden",
    });
  });

  it("an expired session asks for a sign-in, not a failure", () => {
    expect(documentContent(err("UNAUTHORIZED"), undefined)).toEqual({
      kind: "signin",
    });
  });

  it("a binary body refused by the readable door is a file the app opens", () => {
    expect(documentContent(err("BAD_REQUEST"), undefined)).toEqual({
      kind: "file",
    });
    expect(documentContent(null, md("JVBERi0=", "pdf")).kind).toBe("file");
  });

  it("any other failure is an error, never empty content", () => {
    expect(documentContent(err("INTERNAL_SERVER_ERROR"), undefined)).toEqual({
      kind: "error",
    });
    expect(documentContent(null, undefined)).toEqual({ kind: "error" });
  });
});

describe("documentContent — readable bodies", () => {
  it("markdown is prepared for the renderer", () => {
    const out = documentContent(null, md("# Plan\n\nShip it."));
    expect(out).toMatchObject({
      kind: "content",
      prepared: { format: "markdown", text: "# Plan\n\nShip it." },
    });
  });

  it("an html document is shown as its source, never as HTML", () => {
    const out = documentContent(null, md("<script>x()</script>", "html"));
    expect(out).toMatchObject({
      kind: "content",
      prepared: { format: "source", text: "<script>x()</script>" },
    });
  });

  it("an empty body says so", () => {
    expect(documentContent(null, md("  \n"))).toEqual({ kind: "empty" });
  });

  it("an outside reference is a link only when it is http(s)", () => {
    const external = (content: string) =>
      documentContent(null, {
        document: { type: "markdown", storageKey: null, storageUrl: content },
        content,
      });
    expect(external("https://example.com/spec")).toEqual({
      kind: "link",
      href: "https://example.com/spec",
      label: "https://example.com/spec",
    });
    expect(external("javascript:alert(1)")).toMatchObject({
      kind: "link",
      href: null,
    });
  });
});

describe("documentFormat", () => {
  it("names how each stored type is drawn", () => {
    expect(documentFormat("markdown")).toBe("markdown");
    expect(documentFormat("text")).toBe("text");
    expect(documentFormat("code")).toBe("code");
    expect(documentFormat("html")).toBe("source");
    expect(documentFormat("pdf")).toBeNull();
    expect(documentFormat("docx")).toBeNull();
    expect(documentFormat(undefined)).toBe("markdown");
  });
});
