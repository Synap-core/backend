"use client";

/**
 * `MatrixGrid` — the agent × work matrix as a real table (`role="grid"`).
 *
 *   rows     type → computer → agent (groups collapse; a collapsed row shows
 *            ◐ + its split, never one member's verdict)
 *   columns  grouped under their space; the floors column is locked
 *   keys     arrows move · Home / End (Ctrl/⌘: corners) · Enter = why ·
 *            Space = expand / collapse a group (model: `gridKeyAction`)
 *
 * Header row and first column are sticky. One cell holds the tab stop
 * (roving tabindex); every decision is the pure view-model's
 * (`lib/agent-matrix/matrix-view-model.ts`), this file only draws.
 */

import { ChevronRight, Lock, Pause } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  MATRIX_MARKS,
  MATRIX_VERDICTS,
  type AgentMatrix,
  type MatrixCell,
  type MatrixColumn,
} from "@synap-core/types/agent-matrix";
import {
  cellAriaLabel,
  columnGroups,
  gridKeyAction,
  markView,
  type GridPos,
  type MatrixRow,
} from "../../../../../lib/agent-matrix/matrix-view-model";
import { toneTextClass } from "./mark-tone";

export interface MatrixGridProps {
  matrix: AgentMatrix;
  rows: MatrixRow[];
  onToggle: (rowKey: string) => void;
  onWhy: (row: MatrixRow, column: MatrixColumn) => void;
}

export function MatrixGrid({ matrix, rows, onToggle, onWhy }: MatrixGridProps) {
  const { columns } = matrix;
  const groups = useMemo(() => columnGroups(columns), [columns]);
  const tableRef = useRef<HTMLTableElement>(null);
  const [focus, setFocus] = useState<GridPos>({ row: 0, col: 0 });
  const [pendingFocus, setPendingFocus] = useState(false);
  const size = { rows: rows.length, cols: columns.length + 1 };

  // Rows come and go as groups toggle: keep the tab stop on a real cell.
  const pos: GridPos = {
    row: Math.min(focus.row, Math.max(0, size.rows - 1)),
    col: Math.min(focus.col, size.cols - 1),
  };

  useEffect(() => {
    if (!pendingFocus) return;
    setPendingFocus(false);
    tableRef.current
      ?.querySelector<HTMLElement>(`[data-pos="${pos.row}:${pos.col}"]`)
      ?.focus();
  }, [pendingFocus, pos.row, pos.col]);

  function act(at: GridPos, kind: "why" | "toggle") {
    const row = rows[at.row];
    if (!row) return;
    if (kind === "toggle") {
      if (row.kind !== "agent") onToggle(row.key);
      return;
    }
    const column = columns[at.col - 1];
    if (column) onWhy(row, column);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTableElement>) {
    const raw = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]")
      ?.dataset.pos;
    if (!raw) return;
    const [r, c] = raw.split(":").map(Number) as [number, number];
    const here = { row: r, col: c };
    const action = gridKeyAction(
      e.key,
      here,
      size,
      rows[r]?.kind !== "agent",
      e.ctrlKey || e.metaKey
    );
    if (!action) return;
    e.preventDefault();
    if (action.type === "move") {
      setFocus(action.to);
      setPendingFocus(true);
    } else {
      setFocus(action.at);
      act(action.at, action.type);
    }
  }

  const cellProps = (r: number, c: number) => ({
    "data-pos": `${r}:${c}`,
    tabIndex: r === pos.row && c === pos.col ? 0 : -1,
    onFocus: () => setFocus({ row: r, col: c }),
  });

  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg ring-1 ring-inset ring-foreground/10">
      <table
        ref={tableRef}
        role="grid"
        aria-label="Agents and work"
        aria-rowcount={rows.length + 2}
        aria-colcount={columns.length + 1}
        onKeyDown={onKeyDown}
        className="border-separate border-spacing-0 text-[12.5px]"
      >
        <thead>
          <tr role="row">
            <th
              role="columnheader"
              rowSpan={2}
              scope="col"
              className="sticky left-0 top-0 z-30 min-w-[220px] border-b border-r border-foreground/[0.08] bg-background px-3 text-left align-bottom font-medium text-foreground/65"
            >
              <span className="block pb-2">Agent</span>
            </th>
            {groups.map((g) => (
              <th
                key={g.key}
                role="columnheader"
                scope="colgroup"
                colSpan={g.columns.length}
                className="sticky top-0 z-20 h-8 border-b border-l border-foreground/[0.06] bg-background px-3 text-left font-medium text-foreground/80"
              >
                {g.label ?? "Platform"}
              </th>
            ))}
          </tr>
          <tr role="row">
            {columns.map((column) => (
              <th
                key={column.id}
                role="columnheader"
                scope="col"
                className="sticky top-8 z-20 min-w-[104px] max-w-[160px] border-b border-l border-foreground/[0.08] bg-background px-3 py-2 text-left align-bottom font-normal text-foreground/65"
              >
                <span className="flex items-center gap-1.5">
                  {column.kind === "floors" && (
                    <Lock className="h-3 w-3 shrink-0" aria-label="Locked" />
                  )}
                  <span className="line-clamp-2">{column.label}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row.key} role="row" className="group/row">
              <th
                role="rowheader"
                scope="row"
                aria-expanded={row.kind === "agent" ? undefined : row.expanded}
                {...cellProps(r, 0)}
                onClick={() => row.kind !== "agent" && onToggle(row.key)}
                className={[
                  "sticky left-0 z-10 h-10 border-b border-r border-foreground/[0.06] bg-background px-3 text-left font-normal",
                  "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                  row.kind === "agent" ? "" : "cursor-pointer",
                ].join(" ")}
              >
                <RowLabel row={row} />
              </th>
              {columns.map((column, i) => {
                const cell = row.cells[column.id];
                if (!cell)
                  return (
                    <td
                      key={column.id}
                      role="gridcell"
                      {...cellProps(r, i + 1)}
                    />
                  );
                return (
                  <td
                    key={column.id}
                    role="gridcell"
                    aria-label={cellAriaLabel(row.label, column, cell)}
                    {...cellProps(r, i + 1)}
                    onClick={() => {
                      setFocus({ row: r, col: i + 1 });
                      onWhy(row, column);
                    }}
                    className={[
                      "h-10 cursor-pointer border-b border-l border-foreground/[0.06] px-3 text-left",
                      "outline-none transition-colors hover:bg-foreground/[0.04]",
                      "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                      column.kind === "floors" ? "bg-foreground/[0.025]" : "",
                    ].join(" ")}
                  >
                    <CellMark cell={cell} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowLabel({ row }: { row: MatrixRow }) {
  const indent = (row.level - 1) * 16;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      style={{ paddingLeft: indent }}
    >
      {row.kind === "agent" ? (
        <span aria-hidden className="inline-block w-3.5 shrink-0" />
      ) : (
        <ChevronRight
          aria-hidden
          className={[
            "h-3.5 w-3.5 shrink-0 text-foreground/40 transition-transform",
            row.expanded ? "rotate-90" : "",
          ].join(" ")}
        />
      )}
      <span
        className={[
          "truncate",
          row.kind === "agent"
            ? "text-foreground"
            : "font-medium text-foreground/80",
        ].join(" ")}
      >
        {row.label}
      </span>
      {row.kind !== "agent" && (
        <span className="tabular shrink-0 text-[11px] text-foreground/65">
          {row.memberCount}
        </span>
      )}
      {row.agent?.paused && (
        <Pause
          aria-label="Paused"
          className="h-3 w-3 shrink-0 text-status-stale"
        />
      )}
    </span>
  );
}

/** The mark; a mixed cell also shows its split as glyph counts. */
function CellMark({ cell }: { cell: MatrixCell }) {
  const m = markView(cell);
  return (
    <span aria-hidden className="flex items-center gap-2">
      <span
        className={["text-[14px] font-medium", toneTextClass(m.tone)].join(" ")}
      >
        {m.glyph}
      </span>
      {cell.mark === "mixed" && (
        <span className="tabular flex gap-1.5 text-[11px] text-foreground/65">
          {MATRIX_VERDICTS.filter((v) => cell.split[v] > 0).map((v) => (
            <span key={v} className={toneTextClass(MATRIX_MARKS[v].tone)}>
              {cell.split[v]}
              {MATRIX_MARKS[v].glyph}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
