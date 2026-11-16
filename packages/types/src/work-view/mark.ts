/**
 * markOf — the ONE mark (tone + glyph + state) a Work-view thing wears: a
 * request, an Activity entry, a job, a run or a wait. It never names a colour
 * of its own: every answer comes from `resolveUnitState` (`../units/state.ts`)
 * and, for a status move, the canonical category tone
 * (`LIFECYCLE_CATEGORY_TONE`: waiting / paused is `warning`). No second tone
 * list (`one-tone-list.tripwire.test.ts`).
 */

import {
  LIFECYCLE_CATEGORY_TONE,
  resolveRunUnitState,
  resolveUnitState,
  resolveWaitKindState,
  type UnitGlyph,
  type UnitState,
  type UnitStateInput,
  type UnitTone,
} from "../units/state.js";
import type { LifecycleCategory } from "../lifecycle/option.js";
import type { ActivityLineEntry } from "./activity-line.js";
import type { RequestSignal, WorkRequest } from "./requests.js";

export interface WorkMark {
  state: UnitState;
  tone: UnitTone;
  glyph: UnitGlyph;
}

export type MarkSubject =
  | { kind: "unit"; input: UnitStateInput }
  | { kind: "wait"; waitKind: string | null | undefined }
  | { kind: "run"; status: string | null | undefined }
  | {
      kind: "request";
      request: WorkRequest<RequestSignal & { waitKind?: string | null }>;
    }
  | { kind: "activity"; entry: ActivityLineEntry };

/** A status category as a unit-state input: the glyph its state wears. */
const CATEGORY_INPUT: Readonly<Record<LifecycleCategory, UnitStateInput>> = {
  open: { everStarted: false },
  active: { running: true },
  paused: { waitKind: "nobody" },
  done: { terminal: true },
  lost: { failed: true },
};

function view(input: UnitStateInput): WorkMark {
  const { state, tone, glyph } = resolveUnitState(input);
  return { state, tone, glyph };
}

function pick(v: {
  state: UnitState;
  tone: UnitTone;
  glyph: UnitGlyph;
}): WorkMark {
  return { state: v.state, tone: v.tone, glyph: v.glyph };
}

/** The mark of one Work-view thing. See the module rule. */
export function markOf(x: MarkSubject): WorkMark {
  switch (x.kind) {
    case "unit":
      return view(x.input);
    case "wait":
      return pick(resolveWaitKindState(x.waitKind));
    case "run":
      return pick(resolveRunUnitState(x.status));
    case "request": {
      const { request } = x;
      if (request.reason === "failure") return view({ failed: true });
      const waitKind = request.lead.waitKind;
      if (waitKind) return pick(resolveWaitKindState(waitKind));
      return view(
        request.bucket === "decision" || request.bucket === "routine"
          ? { pendingDecisions: request.items.length }
          : { owedFromYou: request.items.length }
      );
    }
    case "activity": {
      const { entry } = x;
      if (entry.failed) return view({ failed: true });
      if (entry.weight === "ask") return view({ owedFromYou: 1 });
      if (entry.category) {
        const base = view(CATEGORY_INPUT[entry.category]);
        return { ...base, tone: LIFECYCLE_CATEGORY_TONE[entry.category] };
      }
      if (entry.source === "activity") {
        // The row's outcome (`ActivityOutcome`): live, parked on you, or settled.
        if (entry.row.outcome === "running") return view({ running: true });
        if (entry.row.outcome === "waiting")
          return view({ waitingOnYou: true });
      }
      return view({ terminal: true });
    }
  }
}
