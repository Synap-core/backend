"use client";

/**
 * `ResponsiveTable` — a list that is a table from `md` up and the house rows
 * (`ResourceRow`) on a phone, one row per object that opens its own page.
 *
 *   md and up: [name (link) + its line under it] [columns…], min 48px rows;
 *              the name is the link (keyboard, middle-click, copy link), and a
 *              click anywhere else on the row opens the same page.
 *   phone:     icon · name · one secondary line · status pill, the row opens.
 *
 * Every row carries `data-row-id`, so `useFocusRow` (`?focus=<id>`) lands on
 * it in either layout. The caller draws loading, empty and error around it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { MD_UP, useMediaQuery } from "../../../lib/use-media-query";
import { ResourceRow } from "./resource-row";
import type { StatusKind } from "./status-pill";

/** The class a plain text cell wears: one muted line, cut at its width. */
export const TEXT_CELL = "min-w-0 truncate text-foreground/65";

export interface TableColumn<Row> {
  header: string;
  /** Its grid track, e.g. `minmax(0,1fr)`. */
  width: string;
  cell: (row: Row) => ReactNode;
  /** The cell's class; defaults to `TEXT_CELL`. */
  className?: string;
}

export interface ResponsiveTableProps<Row> {
  ariaLabel: string;
  rows: readonly Row[];
  /** Unique per row (React key). */
  rowKey: (row: Row) => string;
  /** What `?focus=` names this row by. */
  rowId: (row: Row) => string;
  /** The row's own page. */
  href: (row: Row) => string;
  /** The first column: the name (the link) and an optional line under it. */
  name: {
    header: string;
    width: string;
    label: (row: Row) => string;
    sub?: (row: Row) => ReactNode;
  };
  columns: TableColumn<Row>[];
  /** The phone row's icon, secondary line and pill. */
  phone: (row: Row) => {
    Icon: LucideIcon;
    secondary: string;
    status?: { kind: StatusKind; label: string };
  };
}

export function ResponsiveTable<Row>(props: ResponsiveTableProps<Row>) {
  const wide = useMediaQuery(MD_UP);
  const router = useRouter();
  const { rows, rowKey, rowId, href, name, phone } = props;

  if (!wide) {
    return (
      <div className="-mx-2 divide-y divide-foreground/[0.05]">
        {rows.map((row) => {
          const p = phone(row);
          return (
            <div
              key={rowKey(row)}
              data-row-id={rowId(row)}
              className="rounded-md transition-shadow"
            >
              <ResourceRow
                Icon={p.Icon}
                primary={name.label(row)}
                secondary={p.secondary}
                status={p.status}
                onSelect={() => router.push(href(row))}
                wrap
              />
            </div>
          );
        })}
      </div>
    );
  }

  const grid = {
    gridTemplateColumns: [
      name.width,
      ...props.columns.map((c) => c.width),
    ].join(" "),
  };
  return (
    <div role="table" aria-label={props.ariaLabel} className="-mx-2">
      <div
        role="row"
        style={grid}
        className="grid items-center gap-3 border-b border-foreground/[0.06] px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.04em] text-foreground/65"
      >
        <div role="columnheader">{name.header}</div>
        {props.columns.map((c) => (
          <div key={c.header} role="columnheader">
            {c.header}
          </div>
        ))}
      </div>
      <div role="rowgroup" className="divide-y divide-foreground/[0.05]">
        {rows.map((row) => {
          const to = href(row);
          const sub = name.sub?.(row);
          return (
            <div
              key={rowKey(row)}
              role="row"
              data-row-id={rowId(row)}
              style={grid}
              onClick={() => router.push(to)}
              className="grid min-h-12 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-[12.5px] transition-colors hover:bg-foreground/[0.03]"
            >
              <div role="cell" className="flex min-w-0 flex-col">
                <Link
                  href={to}
                  onClick={(e) => e.stopPropagation()}
                  className="max-w-full truncate rounded-sm text-[13px] font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {name.label(row)}
                </Link>
                {sub && (
                  <span className="truncate text-[11.5px] text-foreground/65">
                    {sub}
                  </span>
                )}
              </div>
              {props.columns.map((c) => (
                <div
                  key={c.header}
                  role="cell"
                  className={c.className ?? TEXT_CELL}
                >
                  {c.cell(row)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
