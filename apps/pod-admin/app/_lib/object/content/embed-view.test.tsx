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
  cellInstanceEmbedRead,
  cellIsHtmlPage,
  type EmbedCellInstanceRead,
  type EmbedCellRead,
} from "./markdown-model";

const KEY = "generated:fleet-report";
const PAGE =
  "<!doctype html><html><head><title>Fleet</title></head><body><h1>Fleet report</h1></body></html>";
const REACT = "export default function Cell() { return <div>Deals</div>; }";
/** How the founder's report (`generated:claude-code-fleet-report`) opens: no doctype, no <html>. */
const TITLE_FIRST_PAGE =
  '<title>Claude Code Fleet Report</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<link rel="preconnect" href="https://fonts.googleapis.com">\n<style>\nbody { margin: 0 }\n</style>\n<h1>Fleet</h1>';

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

describe("a `frame` row that opens with <title> runs as a page", () => {
  it("draws the founder's report in the frame, not as a chip", () => {
    const out = draw(
      block("generated:claude-code-fleet-report"),
      readOf({
        rendererType: "frame",
        rendererSource: TITLE_FIRST_PAGE,
        workspaceId: null,
      })
    );
    expect(iframes(out)).toHaveLength(1);
    expect(unescape(attr(iframes(out)[0]!, "srcdoc")!)).toContain(
      "<h1>Fleet</h1>"
    );
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

// ─── A cell embed that names only an instance ───────────────────────────────

const INSTANCE = "5b0c3f1e-8d2a-4c6b-9e7f-1a2b3c4d5e6f";
const instanceBlock = (attrs = `instanceId="${INSTANCE}"`) =>
  [`:::synap-cell{${attrs}}`, "Read the summary below.", ":::"].join("\n");

/** The read a `cellInstances.get` answer comes back as, through the real model. */
const instanceOf = (data: unknown) =>
  cellInstanceEmbedRead({ isLoading: false, error: null, data });

function drawInstance(
  source: string,
  instance: EmbedCellInstanceRead,
  cell: EmbedCellRead,
  asked: { instances: string[]; cells: string[] } = {
    instances: [],
    cells: [],
  }
) {
  return renderToStaticMarkup(
    <EmbedHostContext.Provider
      value={{
        useEntity: () => ({ state: "unresolved" }),
        useCell: (key) => {
          asked.cells.push(key);
          return cell;
        },
        useCellInstance: (id) => {
          asked.instances.push(id);
          return instance;
        },
      }}
    >
      <MarkdownView source={source} measure="wide" />
    </EmbedHostContext.Provider>
  );
}

const REACT_CELL = readOf({ rendererType: "frame", rendererSource: REACT });

describe("an embedded card by instance shows its real name and card, never 'Card'", () => {
  it("asks for the instance, then for its type as a keyed cell", () => {
    const asked = { instances: [] as string[], cells: [] as string[] };
    drawInstance(
      instanceBlock(),
      instanceOf({ name: "Q3 pipeline", cellType: "cell:crm:deal-board" }),
      REACT_CELL,
      asked
    );
    expect(asked.instances).toEqual([INSTANCE]);
    expect(asked.cells).toEqual(["cell:crm:deal-board"]);
  });

  it("an HTML page instance runs in the isolated frame", () => {
    const out = drawInstance(
      instanceBlock(),
      instanceOf({ name: "Fleet", cellType: KEY }),
      readOf({ rendererType: "iframe", rendererSource: PAGE })
    );
    expect(iframes(out)).toHaveLength(1);
    expect(attr(iframes(out)[0]!, "sandbox")).toBe(CELL_FRAME_SANDBOX);
    expect(unescape(attr(iframes(out)[0]!, "srcdoc")!)).toContain(
      "<h1>Fleet report</h1>"
    );
  });

  it("any other instance is the door to its type, named by the instance", () => {
    const out = drawInstance(
      instanceBlock(),
      instanceOf({ name: "Q3 pipeline", cellType: "cell:crm:deal-board" }),
      REACT_CELL
    );
    expect(iframes(out)).toHaveLength(0);
    expect(out).toMatch(
      /<a [^>]*href="\/open\/cell\/cell%3Acrm%3Adeal-board"[^>]*>(?:(?!<\/a>).)*Q3 pipeline(?:(?!<\/a>).)*<\/a>/
    );
    expect(out).not.toMatch(/>Card</);
  });

  it("an unnamed instance is named by its type; a built-in type is a door, not 'not visible'", () => {
    const out = drawInstance(
      instanceBlock(),
      instanceOf({ name: null, cellType: "entity-list" }),
      readOf(null)
    );
    expect(out).toContain("Entity list");
    expect(out).toContain('href="/open/cell/entity-list"');
    expect(out).not.toContain("isn’t visible to you");
  });

  it("inline in a sentence it is the named door, never a frame", () => {
    const asked = { instances: [] as string[], cells: [] as string[] };
    const out = drawInstance(
      `See :synap-cell{instanceId="${INSTANCE}"} here.`,
      instanceOf({ name: "Fleet", cellType: KEY }),
      readOf({ rendererType: "iframe", rendererSource: PAGE }),
      asked
    );
    expect(iframes(out)).toHaveLength(0);
    expect(asked.cells).toEqual([]);
    expect(out).toMatch(
      /<a [^>]*href="\/open\/cell\/generated%3Afleet-report"[^>]*>(?:(?!<\/a>).)*Fleet(?:(?!<\/a>).)*<\/a>/
    );
  });

  it("the authored label still wins", () => {
    const out = drawInstance(
      instanceBlock(`instanceId="${INSTANCE}" label="Pipeline"`),
      instanceOf({ name: "Q3 pipeline", cellType: "cell:crm:deal-board" }),
      REACT_CELL
    );
    expect(out).toContain("Pipeline");
    expect(out).not.toContain("Q3 pipeline");
  });

  it("an instance not visible to the reader says so, and asks for no cell", () => {
    const asked = { instances: [] as string[], cells: [] as string[] };
    const hidden = cellInstanceEmbedRead({
      isLoading: false,
      error: { data: { code: "NOT_FOUND" } },
      data: undefined,
    });
    expect(hidden.state).toBe("hidden");
    const out = drawInstance(instanceBlock(), hidden, REACT_CELL, asked);
    expect(out).toContain("isn’t visible to you");
    expect(asked.cells).toEqual([]);
  });

  it("a failed read shows the error and a retry, never 'Card' and never 'not visible'", () => {
    const failed = cellInstanceEmbedRead({
      isLoading: false,
      error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      data: undefined,
      retry: () => {},
    });
    expect(failed.state).toBe("failed");
    const out = drawInstance(instanceBlock(), failed, REACT_CELL);
    expect(out).toContain("couldn’t be loaded");
    expect(out).toContain("Try again");
    expect(out).not.toContain("isn’t visible to you");
    expect(out).not.toMatch(/>Card</);
  });

  it("loading is a busy mark, not the word 'Card'", () => {
    const out = drawInstance(
      instanceBlock(),
      cellInstanceEmbedRead({ isLoading: true, error: null, data: undefined }),
      REACT_CELL
    );
    expect(out).toContain('aria-busy="true"');
    expect(out).not.toMatch(/>Card</);
  });
});

describe("cellInstanceEmbedRead — empty and failed are different facts", () => {
  it("a NOT_FOUND / FORBIDDEN answer is hidden; any other error is failed", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN", "BAD_REQUEST"]) {
      expect(
        cellInstanceEmbedRead({
          isLoading: false,
          error: { data: { code } },
          data: undefined,
        }).state
      ).toBe("hidden");
    }
    expect(
      cellInstanceEmbedRead({
        isLoading: false,
        error: { data: null },
        data: undefined,
      }).state
    ).toBe("failed");
  });

  it("an answer without a type is a broken read, not an empty one", () => {
    expect(instanceOf({ name: "x", cellType: "" }).state).toBe("failed");
    expect(instanceOf({ name: "x" }).state).toBe("failed");
  });

  it("a ready instance carries its name and type", () => {
    expect(instanceOf({ name: 3, cellType: "entity-list" })).toEqual({
      state: "ready",
      instance: { name: null, cellType: "entity-list" },
    });
  });
});

describe("cellIsHtmlPage — the stored mechanism decides", () => {
  it("an `iframe` cell is a page", () => {
    expect(
      cellIsHtmlPage({ rendererType: "iframe", rendererSource: "<p>x</p>" })
    ).toBe(true);
  });
  it("a `frame` cell whose source opens with <title> is a page (the founder's report)", () => {
    expect(
      cellIsHtmlPage({
        rendererType: "frame",
        rendererSource: TITLE_FIRST_PAGE,
      })
    ).toBe(true);
    expect(
      cellIsHtmlPage({
        rendererType: "frame",
        rendererSource: "<!-- report -->\n<style>h1{}</style><h1>x</h1>",
      })
    ).toBe(true);
  });
  it("a `frame` cell is a page only when its source opens with markup", () => {
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
