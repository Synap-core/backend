"use client";

/**
 * Content on an object page, read-only: a titled section holding a body drawn
 * by the one renderer (`markdown-view`, loaded on demand), and — when only
 * part of it is drawn — the way to the rest in the app.
 */

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { SectionCard } from "../../../(admin)/components/section-card";
import type { DocumentContent } from "./document-model";
import { EXTERNAL_REL, type PreparedContent } from "./markdown-model";

function ContentSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading content…"
      className="flex max-w-[65ch] flex-col gap-2"
    >
      <div className="h-3 w-full rounded bg-foreground/[0.07] shimmer-pulse" />
      <div className="h-3 w-11/12 rounded bg-foreground/[0.07] shimmer-pulse" />
      <div className="h-3 w-2/3 rounded bg-foreground/[0.07] shimmer-pulse" />
    </div>
  );
}

const MarkdownView = dynamic(() => import("./markdown-view"), {
  loading: () => <ContentSkeleton />,
});

/** A body as the console draws it. Plain text keeps its line breaks. */
export function ContentBody({ prepared }: { prepared: PreparedContent }) {
  switch (prepared.format) {
    case "markdown":
      return <MarkdownView source={prepared.text} />;
    case "text":
      return (
        <p className="max-w-[65ch] whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground/90">
          {prepared.text}
        </p>
      );
    case "code":
    case "source":
      return (
        <pre className="max-h-[32rem] overflow-auto rounded-lg bg-foreground/[0.05] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground/90">
          <code>{prepared.text}</code>
        </pre>
      );
  }
}

/** "Showing about 40% of this" + the app link, under a cut body. */
function TruncatedNote({
  shownPercent,
  openInApp,
}: {
  shownPercent: number;
  openInApp?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-foreground/[0.06] pt-2">
      <p className="text-[12.5px] text-foreground/65">
        Showing about {shownPercent}% of this. Open in app for the rest.
      </p>
      {openInApp}
    </div>
  );
}

/**
 * One titled section of content. `openInApp` is the object's own app link,
 * shown when the body is cut.
 */
export function ContentBlock({
  title,
  prepared,
  openInApp,
}: {
  title: string;
  prepared: PreparedContent;
  openInApp?: ReactNode;
}) {
  return (
    <SectionCard variant="flat" title={title}>
      <ContentBody prepared={prepared} />
      {prepared.truncated && (
        <TruncatedNote
          shownPercent={prepared.shownPercent}
          openInApp={openInApp}
        />
      )}
    </SectionCard>
  );
}

/**
 * A document's body in a section, every state worded: loading, nothing
 * visible, a file only the app opens, an outside link, empty, failed.
 * `hidden` says so in one line — the page around it is the title card.
 */
export function DocumentContentSection({
  title,
  content,
  openInApp,
}: {
  title: string;
  /** `null` while it loads. */
  content: DocumentContent | null;
  openInApp?: ReactNode;
}) {
  if (content?.kind === "content") {
    return (
      <ContentBlock
        title={title}
        prepared={content.prepared}
        openInApp={openInApp}
      />
    );
  }
  return (
    <SectionCard variant="flat" title={title}>
      {content === null ? (
        <ContentSkeleton />
      ) : (
        <ContentNote content={content} />
      )}
    </SectionCard>
  );
}

function ContentNote({ content }: { content: DocumentContent }) {
  const note = (text: string) => (
    <p className="text-[12.5px] text-foreground/65">{text}</p>
  );
  switch (content.kind) {
    case "hidden":
      return note("This isn’t visible to you.");
    case "signin":
      return note("Signing you in…");
    case "file":
      return note("This is a file the Synap app opens.");
    case "empty":
      return note("Nothing written here yet.");
    case "error":
      return note("The content couldn’t be loaded. Try again.");
    case "link":
      return content.href ? (
        <p className="text-[13px] text-foreground/85">
          Points to{" "}
          <a
            href={content.href}
            target="_blank"
            rel={EXTERNAL_REL}
            className="break-all text-primary underline decoration-primary/40 underline-offset-2 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {content.label}
          </a>
        </p>
      ) : (
        note("This points to an address outside the pod.")
      );
    case "content":
      return null;
  }
}
