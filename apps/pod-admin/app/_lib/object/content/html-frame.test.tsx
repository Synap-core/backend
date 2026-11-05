import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import {
  buildCellFrameCsp,
  frameNetworkCodeRefusal,
} from "@synap-core/types/cell-bridge";

// The frame reads the console's client only inside an effect (never on a
// static render); the hook just has to exist.
vi.mock("../../../../lib/trpc", () => ({
  trpc: { useUtils: () => ({ client: {} }) },
}));

import { DocumentContentSection } from "./content-block";
import { documentContent } from "./document-model";
import {
  HtmlFrame,
  HtmlPageBody,
  HtmlPageSection,
  SandboxedFrame,
} from "./html-frame";
import { prepareContent } from "./markdown-model";

const html = (el: ReactElement) => renderToStaticMarkup(el);

/** Every <iframe …> opening tag in the markup. */
function iframes(markup: string): string[] {
  return markup.match(/<iframe\b[^>]*>/gi) ?? [];
}
/** One attribute's value on a tag (attribute names are case-insensitive). */
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

const PAGE =
  "<!doctype html><html><head><title>Q3</title></head><body><script>window.synap.query('entities.list',{profileSlug:'deal'})</script></body></html>";

describe("SandboxedFrame — the isolation", () => {
  const out = html(<SandboxedFrame srcDoc="<p>x</p>" title="Q3 report" />);
  const [tag] = iframes(out);

  it("is one iframe whose sandbox is EXACTLY allow-scripts", () => {
    expect(iframes(out)).toHaveLength(1);
    expect(attr(tag!, "sandbox")).toBe("allow-scripts");
  });

  it("never grants same-origin, forms, popups, modals or top navigation", () => {
    const sandbox = attr(tag!, "sandbox")!.split(/\s+/);
    for (const token of [
      "allow-same-origin",
      "allow-forms",
      "allow-popups",
      "allow-modals",
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
    ]) {
      expect(sandbox).not.toContain(token);
    }
  });

  it("delegates no permission, sends no referrer, has no src URL, is named", () => {
    expect(attr(tag!, "allow")).toBe("");
    expect(attr(tag!, "referrerpolicy")).toBe("no-referrer");
    expect(attr(tag!, "src")).toBeNull();
    expect(attr(tag!, "title")).toBe("Q3 report");
  });
});

describe("a stored HTML page on its document page", () => {
  const answer = {
    document: {
      type: "html",
      storageKey: "k",
      storageUrl: null,
      workspaceId: "ws-1",
    },
    content: PAGE,
  };

  it("runs in the frame by default, the policy first in its srcdoc", () => {
    const out = html(
      <DocumentContentSection
        title="Content"
        content={documentContent(null, answer)}
      />
    );
    const frames = iframes(out);
    expect(frames).toHaveLength(1);
    expect(attr(frames[0]!, "sandbox")).toBe("allow-scripts");
    const srcdoc = unescape(attr(frames[0]!, "srcdoc")!);
    expect(
      srcdoc.startsWith(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${buildCellFrameCsp()}">`
      )
    ).toBe(true);
    expect(srcdoc.indexOf("window.synap = Object.freeze")).toBeLessThan(
      srcdoc.indexOf("entities.list',{profileSlug")
    );
    // The toggle is there, on Page.
    expect(out).toContain("Page");
    expect(out).toContain("Source");
  });

  it("Source is the escaped text, and nothing runs", () => {
    const content = documentContent(null, answer);
    if (content.kind !== "page") throw new Error("expected a page");
    const out = html(
      <HtmlPageSection
        title="Content"
        html={content.html}
        bytes={content.bytes}
        tooLarge={false}
        workspaceId="ws-1"
        source={content.source}
        sourceBody={(p) => <pre>{p.text}</pre>}
        initialView="source"
      />
    );
    expect(iframes(out)).toEqual([]);
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;window.synap.query");
  });

  it("a page over the cap does not run, and says why", () => {
    const out = html(
      <HtmlPageBody
        view="page"
        html={PAGE}
        bytes={3 * 1024 * 1024}
        tooLarge
        workspaceId={null}
        source={prepareContent(PAGE, "source")}
        title="Content"
        sourceBody={(p) => <pre>{p.text}</pre>}
        onShowSource={() => {}}
      />
    );
    expect(iframes(out)).toEqual([]);
    expect(out).toContain("This page is 3");
    expect(out).toContain("The console runs pages up to 2");
    expect(out).toContain("View source");
    expect(out).not.toContain("Show source");
  });

  it("a body that failed to load says so with a retry — never empty", () => {
    const out = html(
      <DocumentContentSection
        title="Content"
        content={{ kind: "error" }}
        onRetry={() => {}}
      />
    );
    expect(out).toContain("The content couldn’t be loaded.");
    expect(out).toContain("Retry");
    expect(iframes(out)).toEqual([]);
  });
});

describe("a page whose code is on a CDN (the one frame policy, R3)", () => {
  const CDN_PAGE =
    '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script></head><body><canvas id="c"></canvas></body></html>';

  it("is not run: the reader reads why, and the source is one click away", () => {
    const out = html(
      <HtmlPageBody
        view="page"
        html={CDN_PAGE}
        bytes={CDN_PAGE.length}
        tooLarge={false}
        workspaceId="ws-1"
        source={prepareContent(CDN_PAGE, "source")}
        title="Content"
        sourceBody={(p) => <pre>{p.text}</pre>}
        onShowSource={() => {}}
      />
    );
    expect(iframes(out)).toEqual([]);
    expect(unescape(out)).toContain(frameNetworkCodeRefusal(CDN_PAGE)!);
    expect(out).toContain("View source");
    expect(out).not.toContain("Show source");
  });

  it("the reader's line is a mark and one short sentence; the hosts sit behind Why", () => {
    const out = html(
      <HtmlFrame html={CDN_PAGE} workspaceId={null} title="Q3" />
    );
    expect(out).toContain("Not run");
    expect(out).toContain("This page can’t run here.");
    // No hostname outside the Why disclosure.
    const [outside, behind] = out.split("<details");
    expect(outside).not.toContain("cdn.jsdelivr.net");
    expect(behind).toContain("Why");
    expect(behind).toContain("cdn.jsdelivr.net");
    // Tokens only: no raw size or alpha-arbitrary surface.
    expect(out).not.toContain("text-[13px]");
    expect(out).not.toContain("bg-foreground/[0.04]");
  });

  it("speaks French in the French catalog locale", () => {
    setAmbientCatalogLocale("fr");
    try {
      const out = html(
        <HtmlFrame html={CDN_PAGE} workspaceId={null} title="Q3" />
      );
      expect(out).toContain("Cette page ne peut pas s’exécuter ici.");
      expect(out).not.toContain("This page can’t run here.");
    } finally {
      setAmbientCatalogLocale("en");
    }
  });

  it("an embedded page shows the host's door beside the reason, never a blank frame", () => {
    const out = html(
      <HtmlFrame
        html={CDN_PAGE}
        workspaceId={null}
        title="Q3"
        refusedAction={<a href="/open/x">Open the page</a>}
      />
    );
    expect(iframes(out)).toEqual([]);
    expect(out).toContain("Open the page");
  });

  it("a page with only web fonts still runs (it draws with system fonts)", () => {
    const page =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><p>Hi</p>';
    const out = html(<HtmlFrame html={page} workspaceId={null} title="Q3" />);
    expect(iframes(out)).toHaveLength(1);
  });
});

describe("Full size (the browser's full screen, on the frame's box)", () => {
  const section = (
    page: string,
    opts: { tooLarge?: boolean; initialView?: "page" | "source" } = {}
  ) =>
    html(
      <HtmlPageSection
        title="Content"
        html={page}
        bytes={page.length}
        tooLarge={opts.tooLarge ?? false}
        workspaceId="ws-1"
        source={prepareContent(page, "source")}
        sourceBody={(p) => <pre>{p.text}</pre>}
        initialView={opts.initialView}
      />
    );

  it("a running page offers Full size, and it is still the one frame, same sandbox", () => {
    const out = section(PAGE);
    expect(out).toContain("Full size");
    const frames = iframes(out);
    expect(frames).toHaveLength(1);
    expect(attr(frames[0]!, "sandbox")).toBe("allow-scripts");
    // The box goes full screen, never the frame: the frame delegates nothing.
    expect(attr(frames[0]!, "allow")).toBe("");
    expect(attr(frames[0]!, "allowfullscreen")).toBeNull();
  });

  it("is not offered for the source, a page too large to run, or a page on a CDN", () => {
    expect(section(PAGE, { initialView: "source" })).not.toContain("Full size");
    expect(section(PAGE, { tooLarge: true })).not.toContain("Full size");
    const cdn =
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script><canvas></canvas>';
    expect(section(cdn)).not.toContain("Full size");
  });

  it("says it in French in the French catalog locale", () => {
    setAmbientCatalogLocale("fr");
    try {
      expect(section(PAGE)).toContain("Plein écran");
    } finally {
      setAmbientCatalogLocale("en");
    }
  });

  it("a filled frame keeps the same isolation, and drops only the inline height", () => {
    const inline = iframes(
      html(<SandboxedFrame srcDoc="<p>x</p>" title="Q3" />)
    )[0]!;
    const filled = iframes(
      html(<SandboxedFrame srcDoc="<p>x</p>" title="Q3" fill />)
    )[0]!;
    for (const name of ["sandbox", "allow", "referrerpolicy", "title"]) {
      expect(attr(filled, name)).toBe(attr(inline, name));
    }
    expect(attr(inline, "class")).toContain("min-h-[420px]");
    expect(attr(filled, "class")).toBe("block h-full w-full bg-white");
  });
});
