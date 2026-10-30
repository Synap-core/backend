/**
 * THE STATE OF A UNIT OF WORK — one derivation, every surface.
 *
 * A session, a project, a run and a scheduled job all answer the same
 * question: *whose turn is it, and is it moving?* Before this existed each
 * surface answered it locally, so "waiting on you" and "working" looked
 * identical in the session room while Relay's list said something else again.
 *
 * This module is PURE and dependency-free at run time (it imports a type
 * and the leaf wait table `./wait-kind.ts`, itself import-free) so Relay
 * (React Native), the browser (Electron), the CLI and the pod can all import
 * the same answer. It is also THE tone table: the tone of a
 * status word ({@link STATUS_TONE}) and of a lifecycle category
 * ({@link LIFECYCLE_CATEGORY_TONE}) live here, beside the unit states'.
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
import type { LifecycleCategory } from "../lifecycle/option.js";
import { waitKindBall, type WaitKind } from "./wait-kind.js";

export const UNIT_STATES = [
  "not_started",
  "working",
  "needs_you",
  "needs_review",
  "blocked",
  "with_them",
  "on_machine",
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
 *
 * `warning` is a heads-up — "you need to act, nothing broke yet" (a sign-in
 * that expired, a connection asking for access). It joined once both palettes
 * carried it (`--synap-tone-warning-fill|ink`, relay `warning` / `warningInk`);
 * no unit-of-work state wears it, `resolveUnitState` never returns it.
 */
export const UNIT_TONES = [
  "primary",
  "ai",
  "info",
  "error",
  "success",
  "warning",
  "textSecondary",
  "textMuted",
] as const;
export type UnitTone = (typeof UNIT_TONES)[number];

/** True when `value` is a real tone token (an authored tone may be anything). */
export function isUnitTone(value: unknown): value is UnitTone {
  return (
    typeof value === "string" &&
    (UNIT_TONES as readonly string[]).includes(value)
  );
}

/**
 * The default tone of each lifecycle CATEGORY — what an option with no
 * authored tone wears (`lifecycleOptionTone`, `@synap-core/types/lifecycle`).
 */
export const LIFECYCLE_CATEGORY_TONE: Readonly<
  Record<LifecycleCategory, UnitTone>
> = {
  open: "textSecondary",
  active: "primary",
  paused: "warning",
  done: "success",
  lost: "error",
};

/**
 * THE STATUS TONE TABLE — the tone of a status WORD, for every surface that
 * paints a stored status it did not derive (a badge, a dot, an enum chip, a
 * property value). The union of the app's two tables (`spatial-ui`
 * `SPATIAL_STATUS_TONE`, `property-renderer` `ENUM_TONE_MAP`), which disagreed
 * on three words; where they did, the calm reading is kept:
 *
 *   rejected   textMuted — a person's decision, not a failure (the activity
 *              outcome rule, `resolveActivityOutcomeView`, says the same);
 *   cancelled  textMuted — it ended without failing (`canceled` likewise);
 *   draft      textMuted — quiet, nothing is pending on anyone.
 *
 * The five lifecycle category words (open, active, paused, done, lost) take
 * their tone from {@link LIFECYCLE_CATEGORY_TONE}, the canonical table, so a
 * status and a lifecycle option never paint one category two ways.
 * `stale` is `paused`'s tone: the reaper's `stale` READS as paused
 * (`SESSION_STATUS_DECLARATION`). `drafting` is the one `ai` word (AI
 * provenance). Keys are lower case; {@link resolveStatusTone} normalises.
 * A word that is not here paints `textMuted`, never a guessed colour.
 */
export const STATUS_TONE: Readonly<Record<string, UnitTone>> = {
  // Succeeded / healthy
  done: LIFECYCLE_CATEGORY_TONE.done,
  complete: "success",
  completed: "success",
  success: "success",
  enabled: "success",
  healthy: "success",
  live: "success",
  applied: "success",
  approved: "success",
  auto_approved: "success",
  accepted: "success",
  published: "success",
  won: "success",
  pass: "success",
  // Failed / broken
  blocked: "error",
  error: "error",
  failed: "error",
  approval_failed: "error",
  fail: "error",
  past_due: "error",
  lost: LIFECYCLE_CATEGORY_TONE.lost,
  unqualified: "error",
  // In flight, or your turn (calm, never red)
  active: LIFECYCLE_CATEGORY_TONE.active,
  open: LIFECYCLE_CATEGORY_TONE.open,
  running: "primary",
  doing: "primary",
  "in-progress": "primary",
  "in progress": "primary",
  in_progress: "primary",
  contacted: "primary",
  qualified: "primary",
  negotiation: "primary",
  blocked_by_policy: "primary",
  waiting_on_you: "primary",
  partial: "primary",
  no_effect: "primary",
  trialing: "primary",
  // On hold, or awaiting a decision
  paused: LIFECYCLE_CATEGORY_TONE.paused,
  stale: LIFECYCLE_CATEGORY_TONE.paused,
  pending: "info",
  proposed: "info",
  review: "info",
  "in-review": "info",
  "in review": "info",
  todo: "info",
  new: "info",
  lead: "info",
  scheduled: "info",
  forming: "info",
  // Quiet / inactive
  draft: "textMuted",
  queued: "textMuted",
  idle: "textMuted",
  disabled: "textMuted",
  cancelled: "textMuted",
  canceled: "textMuted",
  skipped: "textMuted",
  rejected: "textMuted",
  reverted: "textMuted",
  unmeasured: "textMuted",
  // AI provenance
  drafting: "ai",
};

/** The tone of a status word ({@link STATUS_TONE}); unknown or absent ⇒ `textMuted`. */
export function resolveStatusTone(status: string | null | undefined): UnitTone {
  if (!status) return "textMuted";
  const key = status.trim().toLowerCase();
  if (Object.hasOwn(STATUS_TONE, key)) return STATUS_TONE[key]!;
  const dashed = key.replace(/\s+/g, "-");
  return Object.hasOwn(STATUS_TONE, dashed)
    ? STATUS_TONE[dashed]!
    : "textMuted";
}

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
  | "users"
  // A machine holds it (CI, the merge queue, a devbox job, a deploy).
  | "cpu";

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
  /**
   * A run the reaper parked because its session still owes the person an open
   * slot (run status `waiting_on_you`, W2 calm). Your turn — never `failed`.
   */
  waitingOnYou?: boolean;
  /** Slots owed BY the person (`owner: "human"` expected outputs, criterion slots). */
  owedFromYou?: number | null;
  /**
   * Proposals awaiting a decision. `null` means the read FAILED — which is
   * not zero, and is why `unmeasured` exists.
   */
  pendingDecisions?: number | null;
  /** The title of whatever this is waiting on. Waiting on X is not waiting on YOU. */
  blockedBy?: string | null;
  /**
   * WHAT it waits on, on the finer axis ({@link WaitKind}, `./wait-kind.ts`).
   * A wait whose ball is `them` (a person outside) reads `with_them`; one
   * whose ball is `machine` (CI, the merge queue, a devbox job, a deploy)
   * reads `on_machine`. Any other ball changes nothing here: your turn already has its arms
   * above, and other work is `blockedBy`.
   */
  waitKind?: WaitKind | null;
  /** An agent is actively working right now. */
  running?: boolean;
  /**
   * An agent is working on it RIGHT NOW, measured from live state (a turn in
   * flight, agent activity inside the working window: `isSessionWorkingNow`),
   * never the lifecycle guess `running` carries for an older pod. It outranks
   * owed asks and pending decisions (decision E2): they wait "until you can".
   */
  agentAtWork?: boolean;
  /**
   * Open, but nothing is working on it right now (D1: no turn in flight and no
   * activity inside the working window). Reads `paused` — the existing quiet
   * state (muted tone, pause glyph) — never `working`, which the default arm
   * would otherwise claim. Below `unmeasured`: "quiet" is a calm answer, so an
   * unreadable count outranks it.
   */
  idle?: boolean;
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
 * 3. An agent MEASURED at work (`agentAtWork`) outranks the asks it left,
 *    never a gate or a parked run (decision E2, 2026-10-27): its asks wait
 *    "until you can".
 */
export function resolveUnitState(input: UnitStateInput): UnitStateView {
  const pct = pctOf(input.progress);
  const determinate = (fallback: number): UnitRail => ({
    kind: "determinate",
    pct: pct ?? fallback,
  });
  const working = (): UnitStateView => ({
    state: "working",
    tone: "ai",
    glyph: "spark",
    // Striped when there is nothing honest to measure — never a fake 0%.
    rail:
      pct === null
        ? { kind: "striped", pct: null }
        : { kind: "determinate", pct },
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
  // A gate or a parked run STOPPED on the person: blocking, whatever else is
  // happening.
  if (input.checkGate || input.waitingOnYou) {
    return {
      state: "needs_you",
      tone: "primary",
      glyph: "person",
      rail: determinate(0),
    };
  }
  // An agent MEASURED at work outranks the asks it left (decision E2,
  // 2026-10-27): an owed ask or a pending proposal on a session an agent is
  // working reads "asks you when you can", not "waiting on you"
  // (`classifyOwedAsk`'s `working` fold, `@synap-core/types/needs-you`).
  // Derived from live state, never from the lifecycle reading `running`
  // (an older pod's "open" is not an agent at work). Only the two blocking
  // arms above outrank it.
  if (input.agentAtWork) {
    return working();
  }
  if ((input.owedFromYou ?? 0) > 0) {
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
  // Somebody or something ELSE holds it: neither your turn nor a chain of
  // work. A person outside (a client's answer, a signature) reads "With
  // them"; a machine (CI, the merge queue, a devbox job, a deploy) reads "On
  // a machine", quiet, because it moves by itself.
  const ball = waitKindBall(input.waitKind);
  if (ball === "them") {
    return {
      state: "with_them",
      tone: "info",
      glyph: "users",
      rail: determinate(0),
    };
  }
  if (ball === "machine") {
    return {
      state: "on_machine",
      tone: "textSecondary",
      glyph: "cpu",
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
  if (input.running) return working();
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
  if (input.idle) {
    return {
      state: "paused",
      tone: "textMuted",
      glyph: "pause",
      rail:
        pct === null
          ? { kind: "dashed", pct: null }
          : { kind: "determinate", pct },
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

/** The run status the reapers stamp on a run whose session still owes the person. */
export const RUN_STATUS_WAITING_ON_YOU = "waiting_on_you";

/**
 * A RUN's lifecycle status (`automation_runs` / `playbook_runs` / the unified
 * runs read) as a unit-state input — so a run wears the same mark a session
 * does. `waiting_on_you` is your turn (`needs_you`), never a failure;
 * `blocked_by_policy` is `blocked` (a rule stopped it); an unknown or absent
 * status is `unmeasured`, never a guess at calm.
 */
export function unitStateInputOfRunStatus(
  status: string | null | undefined
): UnitStateInput {
  switch (status) {
    case "failed":
      return { failed: true };
    case RUN_STATUS_WAITING_ON_YOU:
      return { waitingOnYou: true };
    case "running":
    case "pending":
    case "queued":
      return { running: true };
    // A governance rule refused the run's effect. Not a failure (nothing
    // broke), not done (the effect never landed), not your turn (there is no
    // answer owed): it is BLOCKED ON A RULE — "waiting on X is not waiting on
    // you". Settled here once; every surface reads it through this mapping.
    case "blocked_by_policy":
      return { blockedBy: "policy" };
    case "completed":
    case "success":
    case "cancelled":
    case "skipped":
      return { terminal: true };
    default:
      return { unreadable: true };
  }
}

/** {@link resolveUnitState} for a run status. */
export function resolveRunUnitState(
  status: string | null | undefined
): UnitStateView {
  return resolveUnitState(unitStateInputOfRunStatus(status));
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
