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
 * The MARKS (scale, bar lengths, path, ring arc, ticks, formatted numbers)
 * come from the shared `chartGeometry` (`@synap-core/types/renderables`), the
 * one copy relay draws from too; this file only picks elements and tokens.
 * Every drawing states its values to assistive tech (`role="img"` + the
 * vocabulary door's `resolveChartSpokenLabel`); the colours are tokens only.
 */

import type { ReactNode } from "react";
import {
  chartGeometry,
  type ChartGeometry,
  type ChartSnapshotModel,
} from "@synap-core/types/renderables";
import {
  resolveChartSpokenLabel,
  resolveChartTableHead,
} from "@synap-core/types/vocabulary";
import { formatDate } from "../../../../lib/format";

type Geometry<K extends ChartGeometry["kind"]> = Extract<ChartGeometry, { kind: K }>;

function Bars({ title, g }: { title: string; g: Geometry<"bars"> }) {
  return (
    <ul
      role="img"
      aria-label={resolveChartSpokenLabel(title, g) ?? title}
      className="flex flex-col gap-1.5"
    >
      {g.bars.map((bar, i) => (
        <li
          key={i}
          aria-hidden="true"
          className="grid items-center gap-2 text-[12.5px]"
          style={{
            gridTemplateColumns: `minmax(0,${g.labelColumnPercent}%) minmax(0,1fr) auto`,
          }}
        >
          <span className="min-w-0 break-words text-foreground/80">
            {bar.labelText}
          </span>
          <svg
            viewBox={`0 0 ${g.track.width} ${g.track.height}`}
            preserveAspectRatio="none"
            className="h-3 w-full overflow-visible"
          >
            <rect
              data-mark=""
              x={bar.x}
              y={bar.y}
              width={bar.w}
              height={bar.h}
              className={bar.negative ? "fill-primary/50" : "fill-primary"}
            />
          </svg>
          <span className="tabular-nums text-foreground/70">
            {bar.valueText}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Line({ title, g }: { title: string; g: Geometry<"line"> }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
        <div
          aria-hidden="true"
          className="flex flex-col justify-between py-0.5 text-right text-[11.5px] tabular-nums text-foreground/60"
        >
          <span>{g.yTicks.top}</span>
          <span>{g.yTicks.bottom}</span>
        </div>
        <svg
          viewBox={`0 0 ${g.width} ${g.height}`}
          role="img"
          aria-label={resolveChartSpokenLabel(title, g) ?? title}
          className="h-auto w-full"
        >
          <line
            x1={g.pad}
            x2={g.width - g.pad}
            y1={g.baseline}
            y2={g.baseline}
            className="stroke-foreground/15"
            strokeWidth={1}
          />
          {g.areaPath && <path d={g.areaPath} className="fill-primary/15" />}
          <path
            d={g.path}
            className="fill-none stroke-primary"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {g.points.map((p, i) => (
            <circle key={i} data-mark="" cx={p.cx} cy={p.cy} r={3} className="fill-primary" />
          ))}
        </svg>
      </div>
      {g.xTicks.length > 0 && (
        <div
          aria-hidden="true"
          className="flex justify-between gap-2 pl-8 text-[11.5px] text-foreground/60"
        >
          {g.xTicks.map((t) => (
            <span key={t.align}>{t.text}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Ring({ title, g }: { title: string; g: Geometry<"ring"> }) {
  const { ring } = g;
  return (
    <div className="flex items-center gap-3">
      <svg
        viewBox={`0 0 ${ring.size} ${ring.size}`}
        role="img"
        aria-label={resolveChartSpokenLabel(title, g) ?? title}
        className="h-16 w-16 shrink-0 -rotate-90"
      >
        <circle
          cx={ring.cx}
          cy={ring.cy}
          r={ring.r}
          className="fill-none stroke-foreground/10"
          strokeWidth={ring.strokeWidth}
        />
        <circle
          cx={ring.cx}
          cy={ring.cy}
          r={ring.r}
          className="fill-none stroke-primary"
          strokeWidth={ring.strokeWidth}
          strokeDasharray={g.dash}
        />
      </svg>
      <div aria-hidden="true" className="flex flex-col">
        <span className="text-[22px] font-semibold tabular-nums text-foreground">
          {g.valueText}
        </span>
        {g.showPercent && (
          <span className="text-[12px] tabular-nums text-foreground/60">
            {g.percentRounded}%
          </span>
        )}
      </div>
    </div>
  );
}

function Table({ title, g }: { title: string; g: Geometry<"table"> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[12.5px]">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr className="border-b border-foreground/[0.08]">
            {resolveChartTableHead(g.shape).map((h) => (
              <th key={h} scope="col" className="px-2 py-1 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.rows.map((row, r) => (
            <tr
              key={r}
              className="border-b border-foreground/[0.06] last:border-b-0"
            >
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={`px-2 py-1 ${cell.numeric ? "tabular-nums" : ""}`}
                >
                  {cell.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Drawing({ g, title }: { g: ChartGeometry; title: string }): ReactNode {
  switch (g.kind) {
    case "bars":
      return <Bars title={title} g={g} />;
    case "line":
      return <Line title={title} g={g} />;
    case "ring":
      return <Ring title={title} g={g} />;
    case "table":
      return <Table title={title} g={g} />;
    case "empty":
      return (
        <p className="text-[12.5px] text-foreground/65">
          This snapshot holds no values.
        </p>
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
      <Drawing g={chartGeometry(model, { formatDate })} title={title} />
    </figure>
  );
}
