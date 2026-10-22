"use client";

/**
 * A chart SNAPSHOT drawn from its numbers — inline SVG, no chart library, no
 * script, nothing fetched. The numbers come from the shared embed model
 * (`describeEmbed` → `chart-snapshot`), already validated for their shape.
 *
 *   categories  horizontal bars on ONE scale (labels wrap in their own
 *               column, so a long label never overlaps or clips at 320px)
 *   series      a line (an area for `chart-area`), one dot per point
 *   scalar      a ring + the number
 *   other       a compact table of the values (composed, points, flow, regions)
 *
 * Every drawing states its values to assistive tech (`role="img"` + a label
 * naming each value); the colours are the app's tokens only.
 */

import type { ReactNode } from "react";
import type {
  ChartCategoryPoint,
  ChartSeriesPoint,
  EmbedModel,
} from "@synap-core/types/renderables";
import { formatDate } from "../../../../lib/format";

type ChartSnapshotModel = Extract<EmbedModel, { kind: "chart-snapshot" }>;

/** How many values the spoken summary names before "and N more". */
const SPOKEN_VALUES = 24;

function num(value: number): string {
  return value.toLocaleString();
}

function spoken(title: string, parts: string[]): string {
  const named = parts.slice(0, SPOKEN_VALUES).join(", ");
  const rest = parts.length - SPOKEN_VALUES;
  return `${title}: ${named}${rest > 0 ? `, and ${rest} more` : ""}`;
}

/** A domain that always holds zero, so every bar starts from one baseline. */
function domain(values: number[]): { lo: number; span: number } {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  return { lo, span: hi - lo || 1 };
}

function Bars({ title, data }: { title: string; data: ChartCategoryPoint[] }) {
  const { lo, span } = domain(data.map((d) => d.value));
  const at = (v: number) => ((v - lo) / span) * 100;
  return (
    <ul
      role="img"
      aria-label={spoken(
        title,
        data.map((d) => `${d.label || "(no label)"} ${num(d.value)}`)
      )}
      className="flex flex-col gap-1.5"
    >
      {data.map((d, i) => {
        const x = at(Math.min(0, d.value));
        const width = Math.max(at(Math.max(0, d.value)) - x, 0);
        return (
          <li
            key={i}
            aria-hidden="true"
            className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)_auto] items-center gap-2 text-[12.5px]"
          >
            <span className="min-w-0 break-words text-foreground/80">
              {d.label || "—"}
            </span>
            <svg
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              className="h-3 w-full overflow-visible"
            >
              <rect
                data-mark=""
                x={x}
                y={0}
                width={width}
                height={10}
                className={d.value < 0 ? "fill-primary/50" : "fill-primary"}
              />
            </svg>
            <span className="tabular-nums text-foreground/70">
              {num(d.value)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function xLabel(x: string | number): string {
  return typeof x === "number" ? num(x) : formatDate(x);
}

const LINE_W = 300;
const LINE_H = 120;
const PAD = 6;

function Line({
  title,
  data,
  area,
}: {
  title: string;
  data: ChartSeriesPoint[];
  area: boolean;
}) {
  // x on time (or the number) when every point has one, else evenly spaced.
  const raw = data.map((p) =>
    typeof p.x === "number" ? p.x : Date.parse(p.x)
  );
  const xs = raw.every(Number.isFinite) ? raw : data.map((_, i) => i);
  const xLo = Math.min(...xs);
  const xSpan = Math.max(...xs) - xLo;
  const { lo, span } = domain(data.map((p) => p.y));
  const points = data.map((p, i) => ({
    cx: xSpan
      ? PAD + ((xs[i]! - xLo) / xSpan) * (LINE_W - 2 * PAD)
      : LINE_W / 2,
    cy: LINE_H - PAD - ((p.y - lo) / span) * (LINE_H - 2 * PAD),
  }));
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(2)},${p.cy.toFixed(2)}`)
    .join(" ");
  const baseline = LINE_H - PAD - ((0 - lo) / span) * (LINE_H - 2 * PAD);
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
        <div
          aria-hidden="true"
          className="flex flex-col justify-between py-0.5 text-right text-[11.5px] tabular-nums text-foreground/60"
        >
          <span>{num(lo + span)}</span>
          <span>{num(lo)}</span>
        </div>
        <svg
          viewBox={`0 0 ${LINE_W} ${LINE_H}`}
          role="img"
          aria-label={spoken(
            title,
            data.map((p) => `${xLabel(p.x)} ${num(p.y)}`)
          )}
          className="h-auto w-full"
        >
          <line
            x1={PAD}
            x2={LINE_W - PAD}
            y1={baseline}
            y2={baseline}
            className="stroke-foreground/15"
            strokeWidth={1}
          />
          {area && first && last && (
            <path
              d={`${path} L${last.cx.toFixed(2)},${baseline.toFixed(2)} L${first.cx.toFixed(2)},${baseline.toFixed(2)} Z`}
              className="fill-primary/15"
            />
          )}
          <path
            d={path}
            className="fill-none stroke-primary"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {points.map((p, i) => (
            <circle key={i} data-mark="" cx={p.cx} cy={p.cy} r={3} className="fill-primary" />
          ))}
        </svg>
      </div>
      {data.length > 0 && (
        <div
          aria-hidden="true"
          className="flex justify-between gap-2 pl-8 text-[11.5px] text-foreground/60"
        >
          <span>{xLabel(data[0]!.x)}</span>
          {data.length > 1 && <span>{xLabel(data[data.length - 1]!.x)}</span>}
        </div>
      )}
    </div>
  );
}

function Ring({
  title,
  value,
  percent,
}: {
  title: string;
  value: number;
  percent: number;
}) {
  // r = 100 / 2π, so the circumference is 100 and the dash IS the percent.
  const r = 15.9155;
  return (
    <div className="flex items-center gap-3">
      <svg
        viewBox="0 0 36 36"
        role="img"
        aria-label={`${title}: ${num(value)} (${Math.round(percent)}%)`}
        className="h-16 w-16 shrink-0 -rotate-90"
      >
        <circle
          cx={18}
          cy={18}
          r={r}
          className="fill-none stroke-foreground/10"
          strokeWidth={3.5}
        />
        <circle
          cx={18}
          cy={18}
          r={r}
          className="fill-none stroke-primary"
          strokeWidth={3.5}
          strokeDasharray={`${percent} 100`}
        />
      </svg>
      <div aria-hidden="true" className="flex flex-col">
        <span className="text-[22px] font-semibold tabular-nums text-foreground">
          {num(value)}
        </span>
        {Math.round(percent) !== value && (
          <span className="text-[12px] tabular-nums text-foreground/60">
            {Math.round(percent)}%
          </span>
        )}
      </div>
    </div>
  );
}

function Table({
  title,
  head,
  rows,
}: {
  title: string;
  head: string[];
  rows: Array<Array<string | number>>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12.5px]">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr className="border-b border-foreground/[0.08]">
            {head.map((h) => (
              <th key={h} scope="col" className="px-2 py-1 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr
              key={r}
              className="border-b border-foreground/[0.06] last:border-b-0"
            >
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={`px-2 py-1 ${typeof cell === "number" ? "tabular-nums" : ""}`}
                >
                  {typeof cell === "number" ? num(cell) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isEmpty(model: ChartSnapshotModel): boolean {
  switch (model.shape) {
    case "scalar":
      return false;
    case "flow":
      return model.data.links.length === 0;
    case "regions":
      return Object.keys(model.data).length === 0;
    default:
      return model.data.length === 0;
  }
}

function Drawing({
  model,
  title,
}: {
  model: ChartSnapshotModel;
  title: string;
}): ReactNode {
  switch (model.shape) {
    case "categories":
      return <Bars title={title} data={model.data} />;
    case "series":
      return (
        <Line
          title={title}
          data={model.data}
          area={model.cellKey === "chart-area"}
        />
      );
    case "scalar":
      return <Ring title={title} value={model.data} percent={model.percent} />;
    case "composed":
      return (
        <Table
          title={title}
          head={["Bucket", "Bar", "Line"]}
          rows={model.data.map((d) => [d.x, d.bar, d.line])}
        />
      );
    case "points":
      return (
        <Table
          title={title}
          head={["Label", "x", "y"]}
          rows={model.data.map((d) => [d.label ?? "—", d.x, d.y])}
        />
      );
    case "flow": {
      const name = new Map(model.data.nodes.map((n) => [n.id, n.label]));
      return (
        <Table
          title={title}
          head={["From", "To", "Value"]}
          rows={model.data.links.map((l) => [
            name.get(l.source) ?? l.source,
            name.get(l.target) ?? l.target,
            l.value,
          ])}
        />
      );
    }
    case "regions":
      return (
        <Table
          title={title}
          head={["Region", "Value"]}
          rows={Object.entries(model.data).map(([k, v]) => [k, v])}
        />
      );
  }
}

/**
 * A frozen chart: its title (`resolveEmbedWords(model).label`), when the
 * numbers were taken, the drawing.
 */
export function ChartSnapshot({
  model,
  title,
}: {
  model: ChartSnapshotModel;
  title: string;
}) {
  return (
    <figure
      data-chart={model.shape}
      className="flex flex-col gap-2 rounded-lg px-3 py-2.5 ring-1 ring-inset ring-foreground/10">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[13px] font-medium text-foreground">
          {title}
        </span>
        <span className="text-[12px] text-foreground/60">
          {model.capturedAt
            ? `Snapshot · ${formatDate(model.capturedAt)}`
            : "Snapshot"}
        </span>
      </figcaption>
      {isEmpty(model) ? (
        <p className="text-[12.5px] text-foreground/65">
          This snapshot holds no values.
        </p>
      ) : (
        <Drawing model={model} title={title} />
      )}
    </figure>
  );
}
