/**
 * RUN ACTIVITY — "what is it doing, what has it done, what waits on me?" as
 * ONE pure derivation over the pod's session-activity wire (./wire.ts).
 *
 * Consumed by the browser session page's Activity block, run-detail's spine
 * for session / playbook runs, and relay's Now line + activity screen. Each
 * surface paints; none of them decides what a step IS, what it is called, or
 * which steps collapse together — that is this file, once.
 *
 * ── What it deliberately does NOT decide ──────────────────────────────────
 * Whether a session is "working right now" beyond a recorded fact. The only
 * live claim made here is an IS turn the pod reports IN FLIGHT. "Activity in
 * the last N minutes means working" is PENDING A FOUNDER DECISION (agent-run
 * spec §10, "what makes an agent working right now" — the stale window and
 * the header mark). Until it lands, an idle session's Now line names what
 * waits on the reader, else its LATEST step and age ("last") — never
 * "working". The header's state mark keeps its own derivation
 * (`resolveUnitState`) unchanged.
 *
 * ── Labels ────────────────────────────────────────────────────────────────
 * No local label map (vocabulary.md). A producer-authored title wins (IS tool
 * steps are already friendly); otherwise verbs and nouns come from
 * `@synap-core/types/vocabulary` — PAST mood for what happened, IMPERATIVE for
 * a decision that waits ("Create task …" is what approving it will do).
 */

import {
  buildObjectActionTitle,
  humanizeToken,
  resolveActionLabel,
  resolveObjectNounPlural,
  resolveStatusLabel,
  sentenceCaseLabel,
} from "../vocabulary/index.js";
import type {
  SessionActivityActor,
  SessionActivityKind,
  SessionActivitySource,
  SessionActivityItem,
  SessionActivityWire,
} from "./wire.js";

/**
 * Where a step stands, for the reader. Every phase has a mark (./marks.ts,
 * a TOTAL table — a new phase without a mark stops the build).
 *
 *   now            — the step an in-flight IS turn is executing.
 *   done           — happened.
 *   waiting_on_you — a decision or ask only the reader can settle.
 *   failed         — ran and did not work.
 *   declined       — a decision the reader (or a reviewer) rejected.
 *   unsettled      — a tool call whose result never arrived in a turn that is
 *                    no longer running. NOT "done": nobody saw it finish.
 */
export const STEP_PHASES = [
  "now",
  "done",
  "waiting_on_you",
  "failed",
  "declined",
  "unsettled",
] as const;
export type StepPhase = (typeof STEP_PHASES)[number];

export interface ActivityStep {
  id: string;
  at: Date;
  kind: SessionActivityKind;
  phase: StepPhase;
  /** The words a surface renders. Never a raw token. */
  label: string;
  action: string | null;
  turnId: string | null;
  objectKind: string | null;
  objectId: string | null;
  objectTitle: string | null;
  proposalId: string | null;
  error: string | null;
  actor: SessionActivityActor | null;
}

/**
 * Consecutive finished steps that say the same thing, collapsed ("Created 5
 * tasks"). A group of one is the common case. `steps` keeps every member so a
 * surface can expand it; nothing is dropped by grouping.
 */
export interface ActivityGroup {
  /** The first member's id — stable while the group only grows. */
  id: string;
  kind: SessionActivityKind;
  phase: StepPhase;
  label: string;
  steps: ActivityStep[];
  /** When the group's newest member happened. */
  at: Date;
}

/**
 * The ONE line at the top, in priority order:
 *   `now`     — an IS turn is executing (a fact the pod recorded);
 *   `waiting` — nothing is in flight and the run is stopped on the READER (a
 *               decision or an ask): the line says so, instead of naming an
 *               older step as if nothing were owed;
 *   `last`    — nothing in flight, nothing owed: the latest step and when.
 */
export const NOW_LINE_MODES = ["now", "waiting", "last"] as const;
export type NowLineMode = (typeof NOW_LINE_MODES)[number];

export interface NowLine {
  mode: NowLineMode;
  /** The step's own words (no mode prefix) — a tooltip, an accessible name. */
  label: string;
  /**
   * The WHOLE line a surface renders — "Last: …", "Waiting on you: …", or the
   * live step's label. Composed here once so no surface prefixes its own.
   */
  text: string;
  /** Null only when the pod reported a turn in flight without its start time. */
  at: Date | null;
  /** The step it names; null when a turn is in flight before its first step. */
  step: ActivityStep | null;
}

export interface RunActivitySummary {
  /** Steps recorded, lifecycle bookends excluded. */
  steps: number;
  /** First → last step. Null under two steps: one instant is not a duration. */
  durationMs: number | null;
  approved: number;
  rejected: number;
  failed: number;
}

export interface RunActivityView {
  now: NowLine | null;
  /** Decisions and asks waiting on the reader, oldest first. Never also in `groups`. */
  waiting: ActivityStep[];
  /** Everything else, grouped, oldest first. Uncapped — see `capActivityGroups`. */
  groups: ActivityGroup[];
  summary: RunActivitySummary;
  /** Sub-reads that failed: the list is PARTIAL, and the surface must say so. */
  unreadable: SessionActivitySource[];
  /** The pod capped the merge; more exists than this view holds. */
  truncated: boolean;
  terminal: boolean;
  /** Nothing has happened AND everything was readable — the only honest "empty". */
  empty: boolean;
}

/** How many history groups a detail surface shows before "Show all". */
export const ACTIVITY_HISTORY_CAP = 8;

/**
 * While a run is LIVE its history sits above what it produced; only this many
 * of the newest groups stay there, so the outputs are not pushed below the
 * fold (ui-composition §6: produced outranks process). The rest is "Show all".
 */
export const ACTIVITY_LIVE_HISTORY_CAP = 3;

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The trailing ellipsis belongs to the RUNNING state, which a surface draws itself. */
function trimEllipsis(text: string): string {
  return text.replace(/[.…]+$/u, "").trim();
}

function phaseOf(
  item: SessionActivityItem,
  liveTurnId: string | null
): StepPhase {
  switch (item.kind) {
    case "tool":
      if (item.status === "failed") return "failed";
      if (item.status === "running") {
        return liveTurnId !== null && item.turnId === liveTurnId
          ? "now"
          : "unsettled";
      }
      return "done";
    case "decision":
      if (item.status === "pending") return "waiting_on_you";
      if (item.status === "rejected") return "declined";
      if (item.status === "failed") return "failed";
      return "done";
    case "ask":
      return item.status === "pending" ? "waiting_on_you" : "done";
    case "error":
      return "failed";
    case "write":
      return item.status === "failed" ? "failed" : "done";
    case "note":
    case "lifecycle":
      return "done";
  }
}

function labelOf(item: SessionActivityItem, phase: StepPhase): string {
  const title = item.title?.trim() ? trimEllipsis(item.title.trim()) : "";
  switch (item.kind) {
    case "tool":
      return title || humanizeToken(item.action ?? "tool");
    case "write":
      return buildObjectActionTitle({
        action: item.action,
        objectKind: item.objectKind,
        objectName: item.objectTitle,
        mood: "past",
      });
    case "decision": {
      const imperative = buildObjectActionTitle({
        action: item.action,
        objectKind: item.objectKind,
        objectName: item.objectTitle,
        mood: "imperative",
      });
      if (phase === "waiting_on_you") return imperative;
      if (phase === "declined") {
        return `${resolveStatusLabel("rejected")}: ${imperative}`;
      }
      return buildObjectActionTitle({
        action: item.action,
        objectKind: item.objectKind,
        objectName: item.objectTitle,
        mood: "past",
      });
    }
    case "ask":
      return title || humanizeToken("ask");
    case "note":
      return title || humanizeToken("note");
    case "error":
      return item.error?.trim() || title || resolveStatusLabel("failed");
    case "lifecycle":
      return buildObjectActionTitle({
        action: item.action,
        objectKind: item.objectKind ?? "session",
        mood: "past",
      });
  }
}

/** Kinds that collapse when consecutive and alike. Everything else stands alone. */
const GROUPABLE: ReadonlySet<SessionActivityKind> = new Set(["tool", "write"]);

function groupKey(step: ActivityStep): string | null {
  if (!GROUPABLE.has(step.kind) || step.phase !== "done") return null;
  if (step.kind === "tool")
    return `tool|${step.turnId ?? ""}|${step.action ?? ""}`;
  return `write|${step.action ?? ""}|${step.objectKind ?? ""}`;
}

function groupLabel(steps: ActivityStep[]): string {
  const first = steps[0]!;
  if (steps.length === 1) return first.label;
  if (first.kind === "write") {
    const verb = resolveActionLabel(first.action, "past");
    const noun = resolveObjectNounPlural(first.objectKind ?? "item");
    return sentenceCaseLabel(`${verb} ${steps.length} ${noun}`);
  }
  return `${first.label} · ${steps.length}`;
}

function nowText(mode: NowLineMode, label: string, waiting: number): string {
  switch (mode) {
    case "now":
      return label;
    case "waiting": {
      const head = `${resolveStatusLabel("waiting_on_you")}: ${label}`;
      return waiting > 1 ? `${head} (+${waiting - 1})` : head;
    }
    case "last":
      return `Last: ${label}`;
  }
}

/** Fold the wire into what a surface renders. Pure: nothing reads the clock. */
export function deriveRunActivity(wire: SessionActivityWire): RunActivityView {
  // Stable sort by time; ties keep the pod's order (seq within a turn).
  const dated = wire.items
    .map((item, index) => ({ item, index, at: toDate(item.at) }))
    .filter(
      (r): r is { item: SessionActivityItem; index: number; at: Date } =>
        r.at !== null
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index);

  // The turn in flight: the pod NAMES it when it can (`live.turnId`). An older
  // pod omits it, and the fallback infers it as the LATEST turn any tool step
  // ran in — which misreads a new turn that has no tool step yet, so an older
  // turn's dangling call would read as live. The named id rules that out.
  let liveTurnId: string | null = null;
  if (wire.live.turnInFlight) {
    if (wire.live.turnId) {
      liveTurnId = wire.live.turnId;
    } else {
      for (const r of dated) {
        if (r.item.kind === "tool" && r.item.turnId) liveTurnId = r.item.turnId;
      }
    }
  }

  const steps: ActivityStep[] = dated.map(({ item, at }) => {
    const phase = phaseOf(item, liveTurnId);
    return {
      id: item.id,
      at,
      kind: item.kind,
      phase,
      label: labelOf(item, phase),
      action: item.action,
      turnId: item.turnId,
      objectKind: item.objectKind,
      objectId: item.objectId,
      // An ask's object IS its owed slot, addressed by the slot's raw label —
      // the `title`, untrimmed (the step's `label` drops a trailing ellipsis,
      // which would no longer name the slot).
      objectTitle:
        item.kind === "ask"
          ? (item.title ?? item.objectTitle)
          : item.objectTitle,
      proposalId: item.proposalId,
      error: item.error,
      actor: item.actor,
    };
  });

  const waiting = steps.filter((s) => s.phase === "waiting_on_you");
  const nowStep = [...steps].reverse().find((s) => s.phase === "now") ?? null;
  const history = steps.filter(
    (s) => s.phase !== "waiting_on_you" && s !== nowStep
  );

  const groups: ActivityGroup[] = [];
  let openKey: string | null = null;
  for (const step of history) {
    const key = groupKey(step);
    const last = groups[groups.length - 1];
    if (key !== null && key === openKey && last) {
      last.steps.push(step);
      last.at = step.at;
      last.label = groupLabel(last.steps);
      continue;
    }
    groups.push({
      id: step.id,
      kind: step.kind,
      phase: step.phase,
      label: step.label,
      steps: [step],
      at: step.at,
    });
    openKey = key;
  }

  const counted = steps.filter((s) => s.kind !== "lifecycle");
  const first = steps[0];
  const last = steps[steps.length - 1];
  const summary: RunActivitySummary = {
    steps: counted.length,
    durationMs:
      steps.length >= 2 && first && last
        ? last.at.getTime() - first.at.getTime()
        : null,
    approved: steps.filter((s) => s.kind === "decision" && s.phase === "done")
      .length,
    rejected: steps.filter((s) => s.phase === "declined").length,
    failed: steps.filter((s) => s.phase === "failed").length,
  };

  const line = (
    mode: NowLineMode,
    label: string,
    at: Date | null,
    step: ActivityStep | null
  ): NowLine => ({
    mode,
    label,
    text: nowText(mode, label, waiting.length),
    at,
    step,
  });

  let now: NowLine | null = null;
  if (!wire.terminal) {
    const firstWaiting = waiting[0];
    if (nowStep) {
      now = line("now", nowStep.label, nowStep.at, nowStep);
    } else if (wire.live.turnInFlight) {
      now = line(
        "now",
        resolveStatusLabel("running"),
        toDate(wire.live.since) ?? toDate(wire.live.lastAt),
        null
      );
    } else if (firstWaiting) {
      // The oldest thing owed: it is what the run stopped on.
      now = line("waiting", firstWaiting.label, firstWaiting.at, firstWaiting);
    } else {
      const latest = [...history].reverse().find((s) => s.kind !== "lifecycle");
      if (latest) now = line("last", latest.label, latest.at, latest);
    }
  }

  return {
    now,
    waiting,
    groups,
    summary,
    unreadable: [...wire.unreadable],
    truncated: wire.truncated,
    terminal: wire.terminal,
    empty: steps.length === 0 && wire.unreadable.length === 0,
  };
}

/** The newest `cap` groups (still oldest first) and how many were held back. */
export function capActivityGroups(
  groups: readonly ActivityGroup[],
  cap: number = ACTIVITY_HISTORY_CAP
): { shown: ActivityGroup[]; hidden: number } {
  if (groups.length <= cap) return { shown: [...groups], hidden: 0 };
  return {
    shown: groups.slice(groups.length - cap),
    hidden: groups.length - cap,
  };
}
