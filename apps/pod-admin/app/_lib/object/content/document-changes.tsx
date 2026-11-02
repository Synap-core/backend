"use client";

/**
 * "What changes" in a text: the whole text, each change where it happens.
 * Three readings, one switch:
 *  - Changes: the text as it will read, added blocks tinted, removed blocks
 *    struck, an edited paragraph marked word by word (the desktop's view).
 *  - Side by side: before and after in two columns, row for row.
 *  - Lines: the source, line by line with line numbers, as a code review
 *    reads it. Code is only ever read this way.
 * Unchanged stretches far from a change fold into one row that opens in
 * place; nothing is dropped. Read-only; the rules are in the model.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Button, Tab, Tabs } from "@heroui/react";
import { ContentBody } from "./content-block";
import {
  foldUnchanged,
  lineCounts,
  lineDiff,
  type ChangeLine,
  type DocumentChange,
  type Folded,
  type LineRow,
  type TextChange,
  type WordSegment,
} from "./document-changes-model";
import { prepareContent } from "./markdown-model";

/** A changed block is short; a whole rewritten body is cut like any other. */
const CHANGE_MAX_CHARS = 20_000;
/** Unchanged blocks kept on each side of a change in the rendered readings. */
const BLOCK_CONTEXT = 1;
/** Unchanged lines kept on each side of a change in the Lines reading. */
const LINE_CONTEXT = 3;

export type Reading = "changes" | "side" | "lines";

const ADD_TONE = "border-l-2 border-status-healthy bg-status-healthy/[0.06]";
const DEL_TONE = "border-l-2 border-status-down bg-status-down/[0.05]";

function Markdown({ text }: { text: string }) {
  return (
    <ContentBody
      prepared={prepareContent(text, "markdown", {
        maxChars: CHANGE_MAX_CHARS,
      })}
      measure="wide"
    />
  );
}

/** Word segments, the removed ones struck, the added ones tinted. */
function Words({ words }: { words: readonly WordSegment[] }) {
  return (
    <>
      {words.map((w, i) =>
        w.op === "same" ? (
          <span key={i}>{w.text}</span>
        ) : w.op === "del" ? (
          <del
            key={i}
            className="rounded-sm bg-status-down/15 text-foreground/70"
          >
            <span className="sr-only">Removed: </span>
            {w.text}
          </del>
        ) : (
          <ins key={i} className="rounded-sm bg-status-healthy/20 no-underline">
            <span className="sr-only">Added: </span>
            {w.text}
          </ins>
        )
      )}
    </>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return (
    <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed text-foreground/90">
      {children}
    </p>
  );
}

/** One block, added or removed, rendered. */
function Block({ tone, text }: { tone: "add" | "del"; text: string }) {
  return (
    <div
      className={`min-w-0 rounded-r-md py-1.5 pl-3 pr-2 ${
        tone === "add"
          ? ADD_TONE
          : `${DEL_TONE} text-foreground/65 line-through decoration-status-down/50`
      }`}
    >
      <span className="sr-only">{tone === "add" ? "Added:" : "Removed:"}</span>
      <Markdown text={text} />
    </div>
  );
}

function Same({ text }: { text: string }) {
  return (
    <div className="min-w-0 py-1 pl-3.5 pr-2 opacity-80">
      <Markdown text={text} />
    </div>
  );
}

/** A changed block in the inline reading. */
function ChangeInline({
  line,
}: {
  line: Extract<ChangeLine, { op: "change" }>;
}) {
  if (line.words) {
    return (
      <div className="min-w-0 rounded-r-md border-l-2 border-warning bg-warning/[0.05] py-1.5 pl-3 pr-2">
        <Prose>
          <Words words={line.words} />
        </Prose>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Block tone="del" text={line.before} />
      <Block tone="add" text={line.after} />
    </div>
  );
}

function FoldButton({
  count,
  noun,
  onOpen,
}: {
  count: number;
  noun: "paragraph" | "line";
  onOpen: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="light"
      className="h-7 self-start px-2 text-[12px] text-foreground/60"
      onPress={onOpen}
    >
      Show {count} unchanged {noun}
      {count === 1 ? "" : "s"}
    </Button>
  );
}

/** Folds opened by the reader, keyed by their first row. */
function useOpenFolds() {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  return {
    isOpen: (from: number) => open.has(from),
    openFold: (from: number) => setOpen((s) => new Set(s).add(from)),
  };
}

type Shown<T> =
  | { kind: "row"; row: T; index: number }
  | { kind: "fold"; count: number; from: number };

/** Rows with their folds, an opened fold drawn as its rows. */
function unfold<T>(
  folded: readonly Folded<T>[],
  isOpen: (from: number) => boolean
): Shown<T>[] {
  return folded.flatMap((f): Shown<T>[] =>
    f.kind === "row"
      ? [f]
      : isOpen(f.from)
        ? f.rows.map((row, k) => ({
            kind: "row" as const,
            row,
            index: f.from + k,
          }))
        : [{ kind: "fold" as const, count: f.rows.length, from: f.from }]
  );
}

function ChangesReading({
  lines,
  side,
}: {
  lines: readonly ChangeLine[];
  side: boolean;
}) {
  const { isOpen, openFold } = useOpenFolds();
  const items = unfold(
    foldUnchanged(lines, (l) => l.op === "same", BLOCK_CONTEXT),
    isOpen
  );
  if (!side) {
    return (
      <div className="flex flex-col gap-1.5">
        {items.map((item) => {
          if (item.kind === "fold") {
            return (
              <FoldButton
                key={`f${item.from}`}
                count={item.count}
                noun="paragraph"
                onOpen={() => openFold(item.from)}
              />
            );
          }
          const line = item.row;
          const key = `r${item.index}`;
          switch (line.op) {
            case "same":
              return <Same key={key} text={line.text} />;
            case "add":
              return <Block key={key} tone="add" text={line.text} />;
            case "del":
              return <Block key={key} tone="del" text={line.text} />;
            case "change":
              return <ChangeInline key={key} line={line} />;
          }
        })}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/55">
        Before
      </p>
      <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/55">
        After
      </p>
      {items.flatMap((item) => {
        if (item.kind === "fold") {
          return [
            <div key={`f${item.from}`} className="col-span-2 flex">
              <FoldButton
                count={item.count}
                noun="paragraph"
                onOpen={() => openFold(item.from)}
              />
            </div>,
          ];
        }
        const line = item.row;
        const key = `r${item.index}`;
        switch (line.op) {
          case "same":
            return [
              <Same key={`${key}a`} text={line.text} />,
              <Same key={`${key}b`} text={line.text} />,
            ];
          case "add":
            return [
              <div key={`${key}a`} className="min-w-0" />,
              <Block key={`${key}b`} tone="add" text={line.text} />,
            ];
          case "del":
            return [
              <Block key={`${key}a`} tone="del" text={line.text} />,
              <div key={`${key}b`} className="min-w-0" />,
            ];
          case "change":
            if (line.words) {
              const words = line.words;
              return [
                <div
                  key={`${key}a`}
                  className={`min-w-0 rounded-r-md py-1.5 pl-3 pr-2 ${DEL_TONE}`}
                >
                  <Prose>
                    <Words words={words.filter((w) => w.op !== "add")} />
                  </Prose>
                </div>,
                <div
                  key={`${key}b`}
                  className={`min-w-0 rounded-r-md py-1.5 pl-3 pr-2 ${ADD_TONE}`}
                >
                  <Prose>
                    <Words words={words.filter((w) => w.op !== "del")} />
                  </Prose>
                </div>,
              ];
            }
            return [
              <Block key={`${key}a`} tone="del" text={line.before} />,
              <Block key={`${key}b`} tone="add" text={line.after} />,
            ];
        }
      })}
    </div>
  );
}

function LineText({ row }: { row: LineRow }) {
  if (row.op !== "same" && row.words) return <Words words={row.words} />;
  return <>{row.text === "" ? " " : row.text}</>;
}

function LinesReading({
  rows,
  code,
}: {
  rows: readonly LineRow[];
  code: boolean;
}) {
  const { isOpen, openFold } = useOpenFolds();
  const items = unfold(
    foldUnchanged(rows, (r) => r.op === "same", LINE_CONTEXT),
    isOpen
  );
  const wrap = code ? "whitespace-pre" : "whitespace-pre-wrap break-words";
  return (
    <div
      data-line-diff=""
      className="max-w-full overflow-x-auto rounded-md bg-foreground/[0.03] py-1 font-mono text-[12px] leading-[1.6] ring-1 ring-inset ring-foreground/10"
    >
      <table className="w-full border-collapse">
        <tbody>
          {items.map((item) => {
            if (item.kind === "fold") {
              return (
                <tr key={`f${item.from}`} className="bg-foreground/[0.03]">
                  <td colSpan={4} className="px-1 py-0.5">
                    <FoldButton
                      count={item.count}
                      noun="line"
                      onOpen={() => openFold(item.from)}
                    />
                  </td>
                </tr>
              );
            }
            const row = item.row;
            const tone =
              row.op === "add"
                ? "bg-status-healthy/[0.08]"
                : row.op === "del"
                  ? "bg-status-down/[0.07]"
                  : "";
            return (
              <tr key={`r${item.index}`} className={tone}>
                <td className="w-0 select-none whitespace-nowrap pl-2 pr-1 text-right align-top text-foreground/35">
                  {row.op !== "add" ? row.oldNo : ""}
                </td>
                <td className="w-0 select-none whitespace-nowrap px-1 text-right align-top text-foreground/35">
                  {row.op !== "del" ? row.newNo : ""}
                </td>
                <td
                  aria-label={
                    row.op === "add"
                      ? "Added"
                      : row.op === "del"
                        ? "Removed"
                        : undefined
                  }
                  className={`w-0 select-none px-1 align-top ${
                    row.op === "add"
                      ? "text-status-healthy"
                      : row.op === "del"
                        ? "text-status-down"
                        : "text-foreground/25"
                  }`}
                >
                  {row.op === "add" ? "+" : row.op === "del" ? "−" : " "}
                </td>
                <td className={`pr-3 align-top text-foreground/90 ${wrap}`}>
                  <LineText row={row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "+12 −3": how many lines it adds and removes. */
function Counts({ rows }: { rows: readonly LineRow[] }) {
  const { added, removed } = lineCounts(rows);
  return (
    <span className="font-mono text-[12px] tabular-nums">
      <span className="text-status-healthy">+{added}</span>{" "}
      <span className="text-status-down">−{removed}</span>
      <span className="sr-only">
        {` lines: ${added} added, ${removed} removed`}
      </span>
    </span>
  );
}

/**
 * One text change, whole. `code` reads it as source only (struck or rendered
 * code would be unreadable).
 */
export function TextDiff({
  change,
  title,
  code = false,
  defaultReading = "changes",
}: {
  change: TextChange;
  title?: string | null;
  code?: boolean;
  /** The reading it opens in (a template update's "Side by side" tab). */
  defaultReading?: Reading;
}) {
  const [reading, setReading] = useState<Reading>(
    code ? "lines" : defaultReading
  );
  const rows = useMemo(
    () => lineDiff(change.before, change.after),
    [change.before, change.after]
  );
  return (
    <section className="flex min-w-0 flex-col gap-2" data-text-diff="">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {title && (
            <h4 className="truncate text-[13px] font-medium text-foreground">
              {title}
            </h4>
          )}
          <Counts rows={rows} />
        </div>
        {!code && (
          <Tabs
            size="sm"
            aria-label="Read this change as"
            selectedKey={reading}
            onSelectionChange={(key) => setReading(key as Reading)}
            classNames={{
              tabList: "bg-foreground/[0.04] rounded-lg",
              tab: "text-[12px]",
            }}
          >
            <Tab key="changes" title="Changes" />
            <Tab key="side" title="Side by side" />
            <Tab key="lines" title="Lines" />
          </Tabs>
        )}
      </div>
      {reading === "lines" ? (
        <LinesReading rows={rows} code={code} />
      ) : (
        <ChangesReading lines={change.lines} side={reading === "side"} />
      )}
    </section>
  );
}

export function DocumentChanges({ changes }: { changes: DocumentChange[] }) {
  return (
    <div className="flex flex-col gap-5">
      {changes.map((change) => (
        <TextDiff key={change.key} change={change} title={change.title} />
      ))}
    </div>
  );
}
