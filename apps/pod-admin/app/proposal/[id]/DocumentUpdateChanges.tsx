"use client";

/**
 * "What changes" for a document update, drawn as what the document IS.
 *
 * A Markdown document's edit keeps its text reading (`fallback`, the existing
 * `DocumentChanges`). When the document is an HTML PAGE, a struck-through
 * source reads as garble (and a Markdown sectioner cuts a page mid-stylesheet),
 * so the reviewer is shown the pages:
 *
 *   Result        the new page, rendered
 *   Before | After both pages, rendered side by side
 *   Lines         the source, line by line, from the two WHOLE pages
 *
 * Every page goes through `HtmlPagePreview`, the door a proposal's pages use
 * everywhere in pod admin (its Page / Source toggle and Full size included). It
 * answers NO pod reads: a page nobody has approved yet may draw, but never
 * reads the viewer's pod, and that is a property of the door, not a flag set
 * here. The rules about which pages are whole and known are in
 * `document-update-model.ts`.
 */

import { useState, type ReactNode } from "react";
import { Tab, Tabs } from "@heroui/react";
import { trpc } from "../../../lib/trpc";
import { isUuid } from "../../../lib/format";
import { HtmlPagePreview } from "../../_lib/object/content/html-preview";
import { TextDiff } from "../../_lib/object/content/document-changes";
import { useReauthOnUnauthorized } from "../../_lib/object/use-reauth";
import { proposalPageT } from "./copy";
import {
  htmlPages,
  htmlReadings,
  htmlReplaceCandidate,
  htmlUnchanged,
  isHtmlDocument,
  type HtmlPages,
  type HtmlReading,
} from "./document-update-model";

export function DocumentUpdateChanges({
  payload,
  envelope,
  documentId,
  workspaceId,
  status,
  fallback,
}: {
  /** The request's own data (`p.request.data ?? p.data`): the op lives here. */
  payload: unknown;
  /** The stored envelope (`p.data`): approval stamps the applied edit on it. */
  envelope: unknown;
  documentId: string | null | undefined;
  workspaceId: string | null;
  status: string;
  /** The text reading, for any document that is not an HTML page. */
  fallback: ReactNode;
}) {
  const t = proposalPageT();
  const candidate = htmlReplaceCandidate(payload);
  const id = documentId && isUuid(documentId) ? documentId : null;
  // Only a whole-body replacement that opens like HTML is worth a read: any
  // other edit keeps its text reading without a request.
  const query = trpc.documents.get.useQuery(
    { documentId: id ?? "", format: "raw" },
    { enabled: candidate !== null && id !== null, retry: false }
  );
  useReauthOnUnauthorized(query.error);

  if (!candidate || !id) return <>{fallback}</>;
  if (query.isLoading) {
    return (
      <p
        role="status"
        aria-busy="true"
        className="text-[12.5px] text-foreground/65"
      >
        {t("html.loading")}
      </p>
    );
  }
  // A failed read is not "no page": say so, and keep the change readable.
  if (query.error || !query.data) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-foreground/65">
          {t("html.unreadable")}
        </p>
        {fallback}
      </div>
    );
  }
  if (!isHtmlDocument(query.data.document)) return <>{fallback}</>;

  const content = (query.data as { content?: unknown }).content;
  const pages = htmlPages({
    status,
    candidate,
    envelope,
    liveContent: typeof content === "string" ? content : null,
  });
  return <HtmlPagesPanel pages={pages} workspaceId={workspaceId} />;
}

/**
 * The pages, drawn. `defaultReading` is where it opens (the way `TextDiff`
 * takes one): a link or a test can open straight on the side-by-side.
 */
export function HtmlPagesPanel({
  pages,
  workspaceId,
  defaultReading = "result",
}: {
  pages: HtmlPages;
  workspaceId: string | null;
  defaultReading?: HtmlReading;
}) {
  const t = proposalPageT();
  const readings = htmlReadings(pages);
  const [picked, setPicked] = useState<HtmlReading>(defaultReading);
  const reading = readings.includes(picked) ? picked : "result";
  const before = pages.before;

  const label: Record<HtmlReading, string> = {
    result: t("html.reading.result"),
    side: t("html.reading.side"),
    lines: t("html.reading.lines"),
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-html-update="">
      {readings.length > 1 && (
        <Tabs
          size="sm"
          aria-label={t("html.reading.label")}
          selectedKey={reading}
          onSelectionChange={(key) => setPicked(key as HtmlReading)}
          classNames={{
            tabList: "w-fit bg-foreground/[0.04] rounded-lg",
            tab: "text-[12px]",
          }}
        >
          {readings.map((r) => (
            <Tab key={r} title={label[r]} />
          ))}
        </Tabs>
      )}
      {before === null && (
        <p className="text-[12.5px] text-foreground/65">{t("html.noBefore")}</p>
      )}
      {htmlUnchanged(pages) && (
        <p className="text-[12.5px] text-foreground/65">
          {t("html.unchanged")}
        </p>
      )}
      {reading === "result" && (
        <HtmlPagePreview
          html={pages.after}
          workspaceId={workspaceId}
          title={t("html.after")}
        />
      )}
      {reading === "side" && before !== null && (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          <PageColumn name={t("html.before")}>
            <HtmlPagePreview
              html={before}
              workspaceId={workspaceId}
              title={t("html.before")}
            />
          </PageColumn>
          <PageColumn name={t("html.after")}>
            <HtmlPagePreview
              html={pages.after}
              workspaceId={workspaceId}
              title={t("html.after")}
            />
          </PageColumn>
        </div>
      )}
      {reading === "lines" && before !== null && (
        <TextDiff change={{ before, after: pages.after, lines: [] }} code />
      )}
    </div>
  );
}

function PageColumn({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-[12px] font-medium uppercase tracking-wide text-foreground/65">
        {name}
      </h4>
      {children}
    </section>
  );
}
