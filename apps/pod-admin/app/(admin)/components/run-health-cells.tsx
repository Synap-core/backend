"use client";

/**
 * The "Serves goal" and "Health" cells of the Automations and Templates
 * inventories. Words and tone come from `runs/_lib/run-health-view.ts`; this
 * only draws them. Pod admin runs the pod: the goal is a door to the app
 * (`/open/track/<id>`), never a status page of its own.
 */

import { StatusPill } from "./status-pill";
import { openIn } from "../../../lib/open-in";
import {
  RUN_HEALTH_LEGEND,
  runHealthCell,
  servesGoalCell,
  type ServedGoalFacts,
} from "../runs/_lib/run-health-view";
import type { RunHealth } from "@synap-core/types/workers/health";

const MARK_CLASS: Record<string, string> = {
  done: "bg-status-healthy",
  failed: "bg-status-down",
  waiting: "bg-status-stale",
  skipped: "bg-status-unknown",
  running: "bg-status-healthy/50",
};

export function ServesGoal({
  goals,
}: {
  goals: ServedGoalFacts | readonly ServedGoalFacts[] | null | undefined;
}) {
  const cell = servesGoalCell(goals);
  if (cell.kind === "none") {
    return <span className="text-foreground/65">{cell.label}</span>;
  }
  const href = openIn({
    kind: "object",
    objectKind: "track",
    id: cell.first.id,
  }).href;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <a
        href={href}
        className="min-w-0 truncate underline-offset-2 hover:underline"
      >
        {cell.first.name}
      </a>
      {cell.more > 0 && (
        <span className="shrink-0 text-foreground/65">+{cell.more}</span>
      )}
    </span>
  );
}

export function RunHealthStrip({
  health,
}: {
  health: RunHealth | null | undefined;
}) {
  const cell = runHealthCell(health);
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <StatusPill kind={cell.kind} label={cell.label} />
      {cell.strip.length > 0 && (
        <span className="flex gap-0.5" role="img" aria-label={cell.sentence}>
          {cell.strip.map((m) => (
            <span
              key={m.runId}
              title={m.title}
              className={`h-2 w-1.5 rounded-sm ${MARK_CLASS[m.mark] ?? ""}`}
            />
          ))}
        </span>
      )}
    </span>
  );
}

/** What each health state and each mark of the strip means. */
export function RunHealthLegend() {
  return (
    <details className="mt-3 px-1 text-[12px] text-foreground/65">
      <summary className="cursor-pointer">What Health means</summary>
      <dl className="mt-2 grid gap-1">
        {RUN_HEALTH_LEGEND.map((l) => (
          <div key={l.state} className="flex flex-wrap items-center gap-2">
            <dt>
              <StatusPill kind={l.kind} label={l.label} />
            </dt>
            <dd>{l.meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2">
        The bars are the last 10 runs, oldest first: green done, red failed,
        orange waiting on a person, grey skipped.
      </p>
    </details>
  );
}
