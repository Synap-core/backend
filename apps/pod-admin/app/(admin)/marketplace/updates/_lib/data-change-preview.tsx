"use client";

/**
 * One change to records, drawn as before → after (finding 4e4b2858, the
 * prototype the founder approved on 4 Nov): what changes and how many were
 * looked at, the two boxes (kind, status or field, count), one reassurance
 * line, the titles that change (capped by the pod, "and N more"), and the
 * records left as they are, grouped by why. Words: `previewWords`.
 */

import { ArrowRight } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import {
  useConsoleLocale,
  useT,
} from "../../../../../lib/i18n/locale-provider";
import type { DataChangePreview } from "./contract";
import { en, fr } from "./copy";
import {
  previewWords,
  type PreviewBox,
  type PreviewList,
} from "./data-change-preview-model";

const CATALOGS = { en, fr };

function Box({
  side,
  label,
  tone,
}: {
  side: PreviewBox;
  label: string;
  tone: "from" | "to";
}) {
  return (
    <div
      aria-label={label}
      className={
        "flex min-w-0 items-center justify-between gap-3 rounded-lg px-3.5 py-3 " +
        (tone === "to"
          ? "bg-status-healthy/10 text-status-healthy"
          : "bg-foreground/[0.04] text-foreground")
      }
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-[13.5px] font-semibold">
          {side.kind}
        </span>
        {side.detail && (
          <span className="truncate text-[12.5px] opacity-80">
            {side.detail}
          </span>
        )}
      </div>
      <span className="text-[20px] font-semibold tabular-nums">
        {side.count}
      </span>
    </div>
  );
}

/** A "See the N" door that opens the capped list of titles under it. */
function TitlesToggle({
  see,
  hide,
  list,
}: {
  see: string;
  hide: string;
  list: PreviewList;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (list.titles.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="self-start text-[12.5px] font-medium text-primary underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {open ? hide : see}
      </button>
      {open && (
        <ul
          id={id}
          className="list-disc columns-1 gap-7 pl-5 text-[12.5px] text-foreground/80 sm:columns-2"
        >
          {list.titles.map((title, i) => (
            <li key={`${i}-${title}`} className="mb-1 break-inside-avoid">
              {title}
            </li>
          ))}
          {list.more && (
            <li className="mb-1 list-none text-foreground/60">{list.more}</li>
          )}
        </ul>
      )}
    </div>
  );
}

export function DataChangePreviewBlock({
  preview,
  control,
  footer,
}: {
  preview: DataChangePreview;
  /** The consent box, before the title (absent for an operator step). */
  control?: (titleId: string) => ReactNode;
  /** Under the block: the count failed, or "an operator step". */
  footer?: ReactNode;
}) {
  const t = useT(CATALOGS);
  const locale = useConsoleLocale();
  const titleId = useId();
  const words = useMemo(() => {
    const lists = new Intl.ListFormat(locale, { type: "conjunction" });
    return previewWords(t, preview, (w) => lists.format(w));
  }, [t, locale, preview]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-start gap-2">
          {control?.(titleId)}
          <span
            id={titleId}
            className="text-[13.5px] font-semibold text-foreground"
          >
            {words.title}
          </span>
        </div>
        <span className="text-[12px] tabular-nums text-foreground/65">
          {words.scope}
        </span>
      </div>

      <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <Box side={words.from} label={t("preview.before")} tone="from" />
        <ArrowRight
          aria-hidden
          className="mx-auto h-4 w-4 rotate-90 text-foreground/50 sm:rotate-0"
        />
        <Box side={words.to} label={t("preview.after")} tone="to" />
      </div>

      {words.notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {words.notes.map((note) => (
            <li
              key={note}
              className="flex items-center gap-2 text-[12.5px] text-foreground/70"
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 flex-none rounded-full bg-status-healthy"
              />
              {note}
            </li>
          ))}
        </ul>
      )}

      <TitlesToggle
        see={words.see}
        hide={t("preview.hide")}
        list={words.list}
      />

      {words.kept && (
        <div className="flex flex-col gap-2 border-t border-foreground/10 pt-3">
          <div className="flex justify-between text-[13px] font-semibold text-foreground">
            <span>{words.kept.title}</span>
            <span className="tabular-nums">{words.kept.count}</span>
          </div>
          {words.kept.groups.map((g) => (
            <div key={g.reason} className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-3 rounded-md bg-foreground/[0.04] px-3 py-2 text-[12.5px] text-foreground/85">
                <span>{g.reason}</span>
                <span className="font-semibold tabular-nums">{g.count}</span>
              </div>
              <TitlesToggle
                see={g.see}
                hide={t("preview.hide")}
                list={g.list}
              />
            </div>
          ))}
        </div>
      )}
      {footer}
    </div>
  );
}
