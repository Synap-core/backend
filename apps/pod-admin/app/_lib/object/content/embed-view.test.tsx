import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CELL_FRAME_SANDBOX } from "@synap-core/types/cell-bridge";

// The frame reads the console's client only inside an effect (never on a
// static render); the hook just has to exist.
vi.mock("../../../../lib/trpc", () => ({
  trpc: { useUtils: () => ({ client: {} }) },
}));

import MarkdownView from "./markdown-view";
import { EmbedHostContext } from "./embed-context";
import {
  cellEmbedRead,
  cellIsHtmlPage,
  type EmbedCellRead,
} from "./markdown-model";

const KEY = "generated:fleet-report";
const PAGE =
  "<!doctype html><html><head><title>Fleet</title></head><body><h1>Fleet report</h1></body></html>";
const REACT = "export default function Cell() { return <div>Deals</div>; }";

const block = (key: string, fallback = "Read the summary below.") =>
  [`:::synap-cell{cellKey="${key}"}`, fallback, ":::"].join("\n");

function draw(source: string, read: EmbedCellRead, asked: string[] = []) {
  return renderToStaticMarkup(
    <EmbedHostContext.Provider
      value={{
        useEntity: () => ({ state: "unresolved" }),
        useCell: (key) => {
          asked.push(key);
          return read;
        },
      }}
    >
      <MarkdownView source={source} measure="wide" />
    </EmbedHostContext.Provider>
  );
}

const iframes = (markup: string) => markup.match(/<iframe\b[^>]*>/gi) ?? [];
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
  return m ? m[1]! : null;
}
const unescape = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

/** The read a stored row comes back as, through the real model. */
const readOf = (data: unknown) =>
  cellEmbedRead({ isLoading: false, error: null, data });

describe("a document's HTML cell runs in the isolated frame", () => {
  const asked: string[] = [];
  const out = draw(
    block(KEY),
    readOf({ rendererType: "frame", rendererSource: PAGE, workspaceId: null }),
    asked
  );
  const [tag] = iframes(out);

  it("asks for the cell by its key, on the reader's floor", () => {
    expect(asked).toEqual([KEY]);
  });

  it("is one iframe holding the cell's HTML, under the shared sandbox", () => {
    expect(iframes(out)).toHaveLength(1);
    expect(attr(tag!, "sandbox")).toBe(CELL_FRAME_SANDBOX);
    expect(attr(tag!, "sandbox")).not.toContain("allow-same-origin");
    expect(attr(tag!, "src")).toBeNull();
    expect(unescape(attr(tag!, "srcdoc")!)).toContain("<h1>Fleet report</h1>");
  });

  it("never draws the page into the console's own DOM", () => {
    const outside = out.replace(/<iframe\b[^>]*>/gi, "");
    expect(outside).not.toContain("<h1>Fleet report</h1>");
  });

  it("keeps the author's prose under it", () => {
    expect(out).toContain("Read the summary below.");
  });
});

describe("a cell the console does not run is a door", () => {
  it("a React cell is a link to its cell card, not a bare chip", () => {
    const out = draw(
      block("cell:crm:deal-board"),
      readOf({ rendererType: "frame", rendererSource: REACT })
    );
    expect(iframes(out)).toHaveLength(0);
    // The chip itself is the link: its name sits inside the <a>.
    expect(out).toMatch(
      /<a [^>]*href="\/open\/cell\/cell%3Acrm%3Adeal-board"[^>]*>(?:(?!<\/a>).)*Deal board(?:(?!<\/a>).)*<\/a>/
    );
  });

  it("with no reader (no host), the chip is still the door", () => {
    const out = renderToStaticMarkup(<MarkdownView source={block(KEY)} />);
    expect(iframes(out)).toHaveLength(0);
    expect(out).toContain('href="/open/cell/generated%3Afleet-report"');
  });

  it("inline in a sentence, an HTML cell is the door, never a frame", () => {
    const out = draw(
      `See :synap-cell{cellKey="${KEY}"} here.`,
      readOf({ rendererType: "iframe", rendererSource: PAGE })
    );
    expect(iframes(out)).toHaveLength(0);
    expect(out).toContain('href="/open/cell/generated%3Afleet-report"');
  });
});

describe("the read's states are distinct", () => {
  it("a failed read shows the error and a retry, never an empty frame", () => {
    const failed = cellEmbedRead({
      isLoading: false,
      error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      data: undefined,
      retry: () => {},
    });
    expect(failed.state).toBe("failed");
    const out = draw(block(KEY), failed);
    expect(iframes(out)).toHaveLength(0);
    expect(out).toContain("couldn’t be loaded");
    expect(out).toContain("Try again");
  });

  it("a cell not visible to the reader says so, and shows no source", () => {
    const out = draw(block(KEY), readOf(null));
    expect(iframes(out)).toHaveLength(0);
    expect(out).toContain("isn’t visible to you");
  });

  it("loading is a busy mark, not a frame and not an error", () => {
    const out = draw(
      block(KEY),
      cellEmbedRead({ isLoading: true, error: null, data: undefined })
    );
    expect(out).toContain('aria-busy="true"');
    expect(iframes(out)).toHaveLength(0);
    expect(out).not.toContain("couldn’t be loaded");
  });

  it("a page over the frame's cap is not run; its door stays", () => {
    const big = PAGE + " ".repeat(2 * 1024 * 1024);
    const out = draw(
      block(KEY),
      readOf({ rendererType: "iframe", rendererSource: big })
    );
    expect(iframes(out)).toHaveLength(0);
    expect(out).toContain("The console runs pages up to");
    expect(out).toContain('href="/open/cell/generated%3Afleet-report"');
  });
});

describe("cellIsHtmlPage — the stored mechanism decides", () => {
  it("an `iframe` cell is a page", () => {
    expect(
      cellIsHtmlPage({ rendererType: "iframe", rendererSource: "<p>x</p>" })
    ).toBe(true);
  });
  it("a `frame` cell is a page only when its source opens as a document", () => {
    expect(
      cellIsHtmlPage({ rendererType: "frame", rendererSource: PAGE })
    ).toBe(true);
    expect(
      cellIsHtmlPage({
        rendererType: "frame",
        rendererSource: "\n  <HTML lang=en>",
      })
    ).toBe(true);
    expect(
      cellIsHtmlPage({ rendererType: "frame", rendererSource: REACT })
    ).toBe(false);
    // JSX that merely contains markup is not a document.
    expect(
      cellIsHtmlPage({
        rendererType: "frame",
        rendererSource: "const x = <html />",
      })
    ).toBe(false);
  });
  it("any other mechanism, or no source, is never run", () => {
    expect(
      cellIsHtmlPage({ rendererType: "builtin", rendererSource: PAGE })
    ).toBe(false);
    expect(
      cellIsHtmlPage({ rendererType: "mcp-app", rendererSource: PAGE })
    ).toBe(false);
    expect(
      cellIsHtmlPage({ rendererType: "iframe", rendererSource: "  " })
    ).toBe(false);
    expect(
      cellIsHtmlPage({ rendererType: "iframe", rendererSource: null })
    ).toBe(false);
  });
});
