"use client";

/**
 * "What changes" for a document edit proposal: each affected section, its
 * changed paragraphs as before / after (word by word for plain prose), what
 * stayed the same folded to a count. Read-only; drawn by the one renderer.
 */

import type { ReactNode } from "react";
import { ContentBody } from "./content-block";
import type { ChangeLine, DocumentChange } from "./document-changes-model";
import { prepareContent } from "./markdown-model";

/** A changed paragraph is short; a whole rewritten body is cut like any other. */
const CHANGE_MAX_CHARS = 20_000;

function Side({
  tone,
  label,
  text,
}: {
  tone: "add" | "del";
  label: string;
  text: string;
}) {
  const ring =
    tone === "add"
      ? "bg-status-healthy/[0.06] ring-status-healthy/30"
      : "bg-status-down/[0.05] ring-status-down/25";
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg px-3 py-2 ring-1 ring-inset ${ring}`}
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65">
        {label}
      </p>
      <ContentBody
        prepared={prepareContent(text, "markdown", {
          maxChars: CHANGE_MAX_CHARS,
        })}
      />
    </div>
  );
}

function Line({ line }: { line: ChangeLine }): ReactNode {
  switch (line.op) {
    case "unchanged":
      return (
        <p className="text-[12px] text-foreground/65">
          {line.count === 1
            ? "1 paragraph unchanged"
            : `${line.count} paragraphs unchanged`}
        </p>
      );
    case "add":
      return <Side tone="add" label="Added" text={line.text} />;
    case "del":
      return <Side tone="del" label="Removed" text={line.text} />;
    case "change":
      if (line.words) {
        return (
          <p className="max-w-[65ch] whitespace-pre-wrap break-words rounded-lg bg-foreground/[0.03] px-3 py-2 text-[14px] leading-relaxed text-foreground/90 ring-1 ring-inset ring-foreground/10">
            {line.words.map((w, i) =>
              w.op === "same" ? (
                <span key={i}>{w.text}</span>
              ) : w.op === "del" ? (
                <del
                  key={i}
                  className="rounded-sm bg-status-down/10 text-foreground/65"
                >
                  <span className="sr-only">Removed: </span>
                  {w.text}
                </del>
              ) : (
                <ins
                  key={i}
                  className="rounded-sm bg-status-healthy/15 no-underline"
                >
                  <span className="sr-only">Added: </span>
                  {w.text}
                </ins>
              )
            )}
          </p>
        );
      }
      return (
        <div className="flex flex-col gap-2">
          <Side tone="del" label="Before" text={line.before} />
          <Side tone="add" label="After" text={line.after} />
        </div>
      );
  }
}

export function DocumentChanges({ changes }: { changes: DocumentChange[] }) {
  return (
    <div className="flex flex-col gap-4">
      {changes.map((change) => (
        <section key={change.key} className="flex flex-col gap-2">
          {change.title && (
            <h4 className="text-[13px] font-medium text-foreground">
              {change.title}
            </h4>
          )}
          {change.lines.map((line, i) => (
            <Line key={i} line={line} />
          ))}
        </section>
      ))}
    </div>
  );
}
