import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setAmbientCatalogLocale } from "@synap-core/types/i18n";
import { OpenObject } from "./open-shell";
import { ReceiverIdentityProvider } from "../_lib/receiver-shell";

/**
 * The frame an `/open` object page draws in: the receiver card for a small
 * object, the full-window reader for big drawn content (`readerLayout`).
 */
const header = { kind: "view", title: "Roadmap board" };
const facts = [{ label: "Layout", value: "Board" }];

describe("OpenObject: the card or the reader", () => {
  beforeEach(() => setAmbientCatalogLocale("en"));

  it("a small object keeps today's card: header, facts, body", () => {
    const out = renderToStaticMarkup(
      <OpenObject header={{ kind: "entity", title: "Alice" }} facts={facts}>
        <p>fields</p>
      </OpenObject>
    );
    expect(out).toContain("min-h-screen");
    expect(out).toContain("<dl");
    expect(out).not.toContain("data-reader");
  });

  it("big content reads in the window: a bar, then a body that owns the scroll", () => {
    const out = renderToStaticMarkup(
      <OpenObject reader="fill" header={header} facts={facts}>
        <p>the board</p>
      </OpenObject>
    );
    expect(out).toContain("h-dvh");
    expect(out).toContain('data-reader="fill"');
    expect(out).toContain("overflow-auto");
    expect(out).not.toContain("min-h-screen");
    // The facts moved into ⋯ (mounted only when opened).
    expect(out).not.toContain("<dl");
    expect(out.indexOf("the board")).toBeGreaterThan(out.indexOf("</header>"));
  });

  it("the bar leads with the mark, then the title and its kind noun", () => {
    const out = renderToStaticMarkup(
      <OpenObject reader="fill" header={header}>
        <p>the board</p>
      </OpenObject>
    );
    const bar = out.slice(0, out.indexOf("</header>"));
    expect(bar.indexOf("<svg")).toBeGreaterThan(-1);
    expect(bar.indexOf("<svg")).toBeLessThan(bar.indexOf("Roadmap board"));
    expect(bar).toContain(">View<");
    expect(bar).toContain("Share");
    expect(bar).toContain('aria-label="More about Roadmap board"');
  });

  it("a page opened from another object shows its trail in the bar, each parent a door", () => {
    const out = renderToStaticMarkup(
      <OpenObject
        reader="document"
        header={{
          ...header,
          breadcrumb: [
            { label: "Acme deal", href: "/open/entity/e1" },
            { label: "Roadmap board" },
          ],
        }}
      >
        <p>the board</p>
      </OpenObject>
    );
    const bar = out.slice(0, out.indexOf("</header>"));
    expect(bar).toContain('aria-label="Breadcrumb"');
    expect(bar).toMatch(/<a[^>]*href="\/open\/entity\/e1"[^>]*>Acme deal<\/a>/);
    expect(bar.indexOf("Acme deal")).toBeLessThan(bar.indexOf("Roadmap board"));
    // The last crumb is the page itself: the title, never a door.
    expect(bar).not.toMatch(/<a[^>]*>[^<]*Roadmap board/);
  });

  it("the mark leads Home for a member; the title is never a door", () => {
    const out = renderToStaticMarkup(
      <ReceiverIdentityProvider canGoHome>
        <OpenObject reader="document" header={header}>
          <p>body</p>
        </OpenObject>
      </ReceiverIdentityProvider>
    );
    expect(out.match(/href="\/home"/g) ?? []).toHaveLength(1);
    expect(out).not.toMatch(/<a[^>]*>[^<]*Roadmap board/);
  });

  it("a reader the server did not find to be a member gets no Home door", () => {
    const out = renderToStaticMarkup(
      <ReceiverIdentityProvider>
        <OpenObject reader="document" header={header}>
          <p>body</p>
        </OpenObject>
      </ReceiverIdentityProvider>
    );
    expect(out).not.toContain('href="/home"');
    expect(out).toContain(">Synap<");
  });

  it("a document's sentence stays in sight above its body", () => {
    const out = renderToStaticMarkup(
      <OpenObject
        reader="document"
        header={{ ...header, kind: "document", summary: "A copy to read." }}
      >
        <p>body</p>
      </OpenObject>
    );
    expect(out).toContain("A copy to read.");
    expect(out.indexOf("A copy to read.")).toBeLessThan(
      out.indexOf("<p>body</p>")
    );
  });
});
