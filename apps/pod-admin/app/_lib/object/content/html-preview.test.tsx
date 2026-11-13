import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../../../lib/trpc", () => ({
  trpc: { useUtils: () => ({ client: {} }) },
}));
vi.mock("./content-block", () => ({
  ContentBody: ({ prepared }: { prepared: { text: string } }) => (
    <pre>{prepared.text}</pre>
  ),
}));

import { HtmlPagePreview } from "./html-preview";
import { ProposedRecordCard } from "../../../proposal/[id]/ProposedRecordCard";
import { proposedRecord } from "../../../proposal/[id]/proposal-record-model";

const PAGE = "<!DOCTYPE html><html><body><h1>Person card</h1></body></html>";

describe("HtmlPagePreview — a proposal's page", () => {
  const out = renderToStaticMarkup(
    <HtmlPagePreview html={PAGE} title="Person card" />
  );
  it("runs in exactly one sandboxed frame, scripts only", () => {
    const frames = out.match(/<iframe\b[^>]*>/gi) ?? [];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatch(/sandbox="allow-scripts"/);
    expect(frames[0]).not.toMatch(/allow-same-origin/);
  });
  it("tells the reader it reads nothing until approved", () => {
    expect(out).toContain("reads nothing from your pod until approved");
  });
});

describe("ProposedRecordCard — a Define Card proposal", () => {
  it("shows the card's HTML as a page, not a clipped text field", () => {
    const record = proposedRecord({
      action: "create",
      kind: "cell",
      changes: [
        { path: "name", label: "", operation: "create", after: "Person card" },
        { path: "rendererSource", label: "", operation: "create", after: PAGE },
      ],
    })!;
    const out = renderToStaticMarkup(<ProposedRecordCard record={record} />);
    expect(out).toMatch(/<iframe\b/);
    expect(out).not.toContain("Show all");
  });
});

describe("a card written for the widget host, in the real frame", () => {
  const CARD =
    "<!DOCTYPE html><html><body><div id=root>Loading…</div><script>SynapWidget.onInit(function(i){});</script></body></html>";
  const srcdocOf = (markup: string) => {
    const m = /srcDoc="([^"]*)"|srcdoc="([^"]*)"/i.exec(markup);
    return (m?.[1] ?? m?.[2] ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&");
  };

  it("a proposal's preview defines SynapWidget and serves the sample, no pod read", () => {
    const doc = srcdocOf(
      renderToStaticMarkup(<HtmlPagePreview html={CARD} title="Person card" />)
    );
    expect(doc).toContain("window.SynapWidget =");
    expect(doc).toContain("Léa Martin");
  });

  it("a plain page is not given a widget host", () => {
    const doc = srcdocOf(
      renderToStaticMarkup(
        <HtmlPagePreview html="<!doctype html><p>hi</p>" title="x" />
      )
    );
    expect(doc).not.toContain("SynapWidget");
  });
});
