"use client";

/**
 * Synap markdown → React elements, read-only. Loaded lazily (`content-block`):
 * the parser is the one dependency a console page without content must not pay
 * for.
 *
 * The tree is markdown-core's own (`parseMarkdown`, the one Synap dialect), and
 * every node becomes an element React escapes. There is no HTML path at all:
 * raw HTML in the source shows as the text it is, a link is followed only when
 * `contentHref` allows it, and an image is never loaded — the reader sees its
 * description and, for a web address, a link to open it.
 */

import { Fragment, useMemo, type ReactNode } from "react";
import Link from "next/link";
import {
  parseMarkdown,
  readableMarkdown,
  resolvePatternMarkers,
  type Embed,
  type MdastNode,
} from "@synap-core/markdown-core";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import {
  contentHref,
  contentMeasureClass,
  EXTERNAL_REL,
  type ContentMeasure,
} from "./markdown-model";

/** The loose shape every node shares — what the fallthrough reads. */
interface AnyNode {
  type: string;
  value?: unknown;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

const ALERT_LABEL: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const HEADING_CLASS: Record<number, string> = {
  1: "text-[17px] font-semibold tracking-tight",
  2: "text-[15.5px] font-semibold tracking-tight",
  3: "text-[14.5px] font-semibold",
};

function children(node: { children?: readonly MdastNode[] }): ReactNode {
  return (node.children ?? []).map((child, i) => (
    <Fragment key={i}>{renderNode(child)}</Fragment>
  ));
}

function textOf(node: AnyNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map((c) => textOf(c as AnyNode)).join("");
}

function ContentLink({
  url,
  children: label,
}: {
  url: string;
  children: ReactNode;
}) {
  const target = contentHref(url);
  if (target.kind === "external") {
    return (
      <a
        href={target.href}
        target="_blank"
        rel={EXTERNAL_REL}
        className="break-words text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {label}
      </a>
    );
  }
  if (target.kind === "internal") {
    return (
      <Link
        href={target.href}
        className="break-words rounded-sm bg-foreground/[0.05] px-1 text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {label}
      </Link>
    );
  }
  return <span>{label}</span>;
}

/** An image is named, never fetched: a remote load leaks who is reading. */
function ImageMention({ url, alt }: { url: string; alt: string }) {
  const label = `Image${alt.trim() ? `: ${alt.trim()}` : ""}`;
  const target = contentHref(url);
  const chip =
    "inline-flex max-w-full items-center rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-[12.5px] text-foreground/80 ring-1 ring-inset ring-foreground/10";
  return target.kind === "external" ? (
    <a
      href={target.href}
      target="_blank"
      rel={EXTERNAL_REL}
      className={`${chip} underline decoration-foreground/30 underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
    >
      {label}
    </a>
  ) : (
    <span className={chip}>{label}</span>
  );
}

function renderNode(node: MdastNode): ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p>{children(node)}</p>;
    case "heading": {
      // The object's own title is the page heading; content headings sit
      // under the section heading, so they start three levels down.
      const Tag = (["h4", "h5", "h6"] as const)[Math.min(node.depth, 3) - 1]!;
      return (
        <Tag
          className={`pt-1 text-foreground ${HEADING_CLASS[Math.min(node.depth, 3)]}`}
        >
          {children(node)}
        </Tag>
      );
    }
    case "thematicBreak":
      return <hr className="border-foreground/10" />;
    case "blockquote": {
      const alert = (node.data as { alert?: string } | undefined)?.alert;
      if (alert && ALERT_LABEL[alert]) {
        return (
          <div className="flex flex-col gap-1 rounded-lg bg-foreground/[0.04] px-3 py-2.5 ring-1 ring-inset ring-foreground/10">
            <p className="text-[12px] font-medium text-foreground/65">
              {ALERT_LABEL[alert]}
            </p>
            <div className="flex flex-col gap-2">{children(node)}</div>
          </div>
        );
      }
      return (
        <blockquote className="flex flex-col gap-2 border-l-2 border-foreground/15 pl-3 text-foreground/80">
          {children(node)}
        </blockquote>
      );
    }
    case "list": {
      const className = `flex flex-col gap-1 pl-5 ${node.ordered ? "list-decimal" : "list-disc"}`;
      return node.ordered ? (
        <ol className={className} start={node.start ?? undefined}>
          {children(node)}
        </ol>
      ) : (
        <ul className={className}>{children(node)}</ul>
      );
    }
    case "listItem":
      if (typeof node.checked === "boolean") {
        return (
          <li className="list-none">
            <span className="-ml-5 flex items-start gap-2">
              <input
                type="checkbox"
                checked={node.checked}
                readOnly
                disabled
                aria-label={node.checked ? "Done" : "Not done"}
                className="mt-1.5 shrink-0"
              />
              <span className="flex min-w-0 flex-col gap-1 [&>p]:inline">
                {children(node)}
              </span>
            </span>
          </li>
        );
      }
      return (
        <li className="[&>p]:mb-1 [&>p:last-child]:mb-0">{children(node)}</li>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg bg-foreground/[0.05] px-3 py-2.5 font-mono text-[12.5px] leading-relaxed text-foreground/90">
          <code>{node.value}</code>
        </pre>
      );
    case "math":
      return (
        <pre className="overflow-x-auto rounded-lg bg-foreground/[0.05] px-3 py-2.5 font-mono text-[12.5px] text-foreground/90">
          <code>{node.value}</code>
        </pre>
      );
    case "html":
      return (
        <code className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-foreground/75">
          {node.value}
        </code>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <tbody>
              {node.children.map((row, r) => (
                <tr
                  key={r}
                  className="border-b border-foreground/[0.08] last:border-b-0"
                >
                  {row.children.map((cell, c) => {
                    const Cell = r === 0 ? "th" : "td";
                    return (
                      <Cell
                        key={c}
                        className={`px-2 py-1.5 align-top ${r === 0 ? "font-medium text-foreground" : ""}`}
                        style={{ textAlign: node.align?.[c] ?? undefined }}
                      >
                        {children(cell)}
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "text":
      return node.value;
    case "emphasis":
      return <em>{children(node)}</em>;
    case "strong":
      return <strong className="font-semibold">{children(node)}</strong>;
    case "delete":
      return <del className="text-foreground/65">{children(node)}</del>;
    case "mark":
      return (
        <mark className="rounded-sm bg-warning/25 px-0.5 text-foreground">
          {children(node)}
        </mark>
      );
    case "inlineCode":
      return (
        <code className="rounded bg-foreground/[0.06] px-1 py-px font-mono text-[12.5px]">
          {node.value}
        </code>
      );
    case "break":
      return <br />;
    case "link":
      return <ContentLink url={node.url}>{children(node)}</ContentLink>;
    case "image":
      return <ImageMention url={node.url} alt={node.alt ?? ""} />;
    case "imageReference":
      return <ImageMention url="" alt={node.alt ?? ""} />;
    // A definition is the target of a reference link; the reference already
    // shows its words.
    case "definition":
      return null;
    case "footnoteReference":
      return <sup className="text-foreground/65">[{node.label ?? ""}]</sup>;
    default: {
      // Directives (`:::synap-section`, `:u[…]`) and anything newer than
      // this walker: draw what they hold, never drop the words.
      const loose = node as AnyNode;
      if (loose.children) return children(loose);
      return typeof loose.value === "string" ? loose.value : textOf(loose);
    }
  }
}

/** An embed with no authored fallback reads as its noun ("*Chart*"). */
function embedLabel(embed: Embed): string {
  return resolveObjectNoun(embed.kind);
}

/**
 * `source` drawn read-only, in its readable form: an embed (a live cell, an
 * entity card) shows the prose its author gave it — the console runs no
 * cells. Object markers (`[[entity:id|Ana]]`) become their console pages; the
 * rest follows `renderNode`.
 */
export default function MarkdownView({
  source,
  measure = "reading",
}: {
  source: string;
  measure?: ContentMeasure;
}) {
  const tree = useMemo(
    () =>
      parseMarkdown(
        resolvePatternMarkers(readableMarkdown(source, embedLabel))
      ),
    [source]
  );
  return (
    <div
      className={`flex min-w-0 ${contentMeasureClass(measure)} flex-col gap-3 break-words text-[14px] leading-relaxed text-foreground/90`}
    >
      {children(tree)}
    </div>
  );
}
