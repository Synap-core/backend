/**
 * THE STATE OF A UNIT OF WORK — one derivation, every surface.
 *
 * A session, a project, a run and a scheduled job all answer the same
 * question: *whose turn is it, and is it moving?* Before this existed each
 * surface answered it locally, so "waiting on you" and "working" looked
 * identical in the session room while Relay's list said something else again.
 *
 * This module is PURE and dependency-free so Relay (React Native), the
 * browser (Electron), the CLI and the pod can all import the same answer.
 * It returns a TONE TOKEN NAME, never a colour: each surface maps the token
 * through its own palette, which is what keeps light and dark honest and
 * stops a hex literal being invented at a call site.
 *
 * ── THE TWO PAIRS THAT ARE NEVER MERGED ────────────────────────────────────
 * `done` vs `unmeasured` — "nothing is waiting on you" and "I could not find
 * out" are different facts. Collapsing them is the calm-confident-wrong bug
 * this product has shipped three times (a down pod reading "Ready to
 * activate"; zero diagnostics reading as healthy; a failed project read
 * rendering as "no project").
 *
 * `needs_you` vs `needs_review` — an ANSWER is not a JUDGEMENT. They share a
 * tone deliberately (both are your turn) and differ by glyph and label. There
 * is no third accent token in the palette, and inventing one would fork it.
 */

export const UNIT_STATES = [
  "not_started",
  "working",
  "needs_you",
  "needs_review",
  "blocked",
  "scheduled",
  "paused",
  "done",
  "unmeasured",
  "failed",
] as const;
export type UnitState = (typeof UNIT_STATES)[number];

/**
 * A palette token NAME. Every one of these already exists in Relay's theme
 * (`relay-theme.ts`) and in the browser's `--synap-*` set; this list may not
 * grow without a token existing on BOTH surfaces first.
 */
export type UnitTone =
  | "primary"
  | "ai"
  | "info"
  | "error"
  | "success"
  | "textSecondary"
  | "textMuted";

/** Which mark the state wears. Surfaces map these to their own icon set. */
export type UnitGlyph =
  | "person"
  | "scales"
  | "spark"
  | "clock"
  | "pause"
  | "link"
  | "check"
  | "question"
  | "alert"
  | "dashed-circle"
  // Share state (`resolveShareState`, ./share.ts): private / public / guests.
  | "lock"
  | "globe"
  | "users";

/**
 * The progress rail. `none` is not "0%" — a rail implies motion, so a unit
 * that has never started shows none at all. `dashed` means the progress is
 * not real yet (scheduled) or not knowable (unmeasured); rendering either as
 * a determinate 0% would assert a measurement nobody made.
 */
export type UnitRailKind = "none" | "determinate" | "striped" | "dashed";

export interface UnitRail {
  kind: UnitRailKind;
  /** 0–100, and ONLY when `kind === "determinate"`. Null otherwise. */
  pct: number | null;
}

export interface UnitStateView {
  state: UnitState;
  tone: UnitTone;
  glyph: UnitGlyph;
  rail: UnitRail;
}

export interface UnitStateInput {
  /** Closed, cancelled or otherwise finished. */
  terminal?: boolean;
  /** It ran and it did not work. Outranks everything: silence here is expensive. */
  failed?: boolean;
  /** A `check` stage gate paused the run pending a person. */
  checkGate?: boolean;
  /** Slots owed BY the person (`owner: "human"` expected outputs, criterion slots). */
  owedFromYou?: number | null;
  /**
   * Proposals awaiting a decision. `null` means the read FAILED — which is
   * not zero, and is why `unmeasured` exists.
   */
  pendingDecisions?: number | null;
  /** The title of whatever this is waiting on. Waiting on X is not waiting on YOU. */
  blockedBy?: string | null;
  /** An agent is actively working right now. */
  running?: boolean;
  /** A recurring unit's cadence, straight off `playbooks.schedule`. */
  schedule?: { cron: string; enabled: boolean } | null;
  /** False = it exists but nothing has happened in it yet. */
  everStarted?: boolean;
  /** Measurable progress. Absent = not measurable, which is not the same as 0. */
  progress?: { done: number; total: number } | null;
  /** Some input this state depends on could not be read. */
  unreadable?: boolean;
}

function pctOf(
  p: { done: number; total: number } | null | undefined
): number | null {
  if (!p || p.total <= 0) return null;
  const raw = (p.done / p.total) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * ORDER IS THE RULE. Two lessons are encoded in it, both paid for:
 *
 * 1. An unknown removes only the NEGATIVE claim, never a live answer. A
 *    session with a paused check is waiting on you whether or not the
 *    proposal pack could be read — so `unmeasured` sits BELOW every
 *    actionable arm and above the calm ones.
 * 2. Something you can act on now outranks something you can only wait for,
 *    so a pending decision beats a blocker.
 */
export function resolveUnitState(input: UnitStateInput): UnitStateView {
  const pct = pctOf(input.progress);
  const determinate = (fallback: number): UnitRail => ({
    kind: "determinate",
    pct: pct ?? fallback,
  });

  if (input.failed) {
    return {
      state: "failed",
      tone: "error",
      glyph: "alert",
      rail: determinate(100),
    };
  }
  if (input.terminal) {
    return {
      state: "done",
      tone: "textSecondary",
      glyph: "check",
      rail: determinate(100),
    };
  }
  if (input.checkGate || (input.owedFromYou ?? 0) > 0) {
    return {
      state: "needs_you",
      tone: "primary",
      glyph: "person",
      rail: determinate(0),
    };
  }
  if ((input.pendingDecisions ?? 0) > 0) {
    return {
      state: "needs_review",
      tone: "primary",
      glyph: "scales",
      rail: determinate(0),
    };
  }
  if (input.blockedBy) {
    return {
      state: "blocked",
      tone: "textSecondary",
      glyph: "link",
      rail: determinate(0),
    };
  }
  if (input.running) {
    return {
      state: "working",
      tone: "ai",
      glyph: "spark",
      // Striped when there is nothing honest to measure — never a fake 0%.
      rail:
        pct === null
          ? { kind: "striped", pct: null }
          : { kind: "determinate", pct },
    };
  }
  if (input.schedule) {
    return input.schedule.enabled
      ? {
          state: "scheduled",
          tone: "info",
          glyph: "clock",
          rail: { kind: "dashed", pct: null },
        }
      : {
          state: "paused",
          tone: "textMuted",
          glyph: "pause",
          rail: { kind: "dashed", pct: null },
        };
  }
  // Only here: an unreadable input can remove the calm answer, never a live one.
  if (
    input.unreadable ||
    input.pendingDecisions === null ||
    input.owedFromYou === null
  ) {
    return {
      state: "unmeasured",
      tone: "textSecondary",
      glyph: "question",
      rail: { kind: "dashed", pct: null },
    };
  }
  if (input.everStarted === false) {
    return {
      state: "not_started",
      tone: "textMuted",
      glyph: "dashed-circle",
      // No rail at all. A rail implies motion.
      rail: { kind: "none", pct: null },
    };
  }
  return { state: "working", tone: "ai", glyph: "spark", rail: determinate(0) };
}

/**
 * Cadence as words, from a cron expression. Deliberately NARROW: it reads the
 * shapes the pod actually stores (daily, weekly, hourly, every-N-hours) and
 * otherwise hands back the raw expression rather than guessing. A cadence
 * label that is confidently wrong is worse than one that admits it is a cron.
 */
export function describeCadence(
  schedule: { cron: string; enabled: boolean } | null | undefined
): string | null {
  if (!schedule) return null;
  const parts = schedule.cron.trim().split(/\s+/);
  if (parts.length < 5) return schedule.cron;
  const [min, hour, dom, , dow] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const at = (h: string, m: string) =>
    `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  if (/^\*\/(\d+)$/.test(hour) && min === "0") {
    const n = hour.split("/")[1];
    return `Every ${n}h`;
  }
  if (hour === "*" && /^\d+$/.test(min)) return "Hourly";
  if (/^\d+$/.test(hour) && /^\d+$/.test(min)) {
    if (dow !== "*" && /^\d$/.test(dow)) {
      return `${DAYS[Number(dow)] ?? "Weekly"} ${at(hour, min)}`;
    }
    if (dom === "*") return `Daily ${at(hour, min)}`;
  }
  return schedule.cron;
}
