/**
 * TURN ACTIVITY — "what is the AI doing in this reply, and what did it do?" as
 * ONE pure derivation over a single chat turn's steps. The CHAT twin of
 * `deriveRunActivity` (./derive.ts): the surface paints, this file decides what
 * a step IS, what it is called, and where the turn stands.
 *
 * Read by every chat surface — live (the streaming bubble) and at rest (a
 * settled reply's persisted `metadata.aiSteps`), so a trace cannot read one way
 * while it streams and another once it lands.
 *
 * ── Input ─────────────────────────────────────────────────────────────────
 * The steps exactly as the IS emits them (`agents/base/ai-step-factory.ts`,
 * relayed by `routes/chat-stream.ts` as `{ type: "step", step }`) and as they
 * persist on the message. Calls are paired with results by THE one rule
 * (`pairToolRunSteps`, ./tool-runs.ts) — never a local copy.
 *
 * ── Tool states (modelled on the AI SDK tool-part lifecycle) ─────────────
 *   pending            — announced, not started (`status: "pending"`).
 *   running            — open call in a turn still streaming.
 *   awaiting_approval  — the call SUCCEEDED by filing a proposal
 *                        (`toolOutput.status === "proposed"`): queued for the
 *                        person, not an error, not done.
 *   done               — settled; or its proposal was applied.
 *   failed             — the call or its result errored; or the proposal failed.
 *   denied             — its proposal was rejected / withdrawn / expired.
 *   cancelled          — open when the person pressed Stop.
 *   unsettled          — open in a turn that ENDED without a result. Nobody
 *                        saw it finish — the run side's `unsettled`, not "done".
 *   unknown            — it filed a proposal, but where that proposal stands
 *                        could not be read (the bucket read FAILED, or the
 *                        status is one nobody classified). Never "awaiting":
 *                        a failed read must not look like calm pending.
 *
 * ── Labels ────────────────────────────────────────────────────────────────
 * A known tool's words come from `resolveToolLabel` (vocabulary) in BOTH moods
 * — progressive while it runs, past once it settled. An unknown tool keeps the
 * producer's title (stripped of its ellipsis) before falling back to the
 * humanized name. No local label map.
 */

import {
  isKnownToolName,
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveActionLabel,
  resolveStatusLabel,
  resolveToolLabel,
} from "../vocabulary/index.js";
import type { UnitGlyph, UnitTone } from "../units/state.js";
import { stepMark, type StepMark } from "./marks.js";
import {
  pairToolRunSteps,
  projectToolRuns,
  toolRunResultFailed,
  type ToolRunStep,
} from "./tool-runs.js";

// ─── Vocabulary of states ────────────────────────────────────────────────────

export const TURN_PHASES = [
  "working",
  "complete",
  "failed",
  "cancelled",
] as const;
export type TurnPhase = (typeof TURN_PHASES)[number];

export const TURN_TOOL_STATES = [
  "pending",
  "running",
  "awaiting_approval",
  "done",
  "failed",
  "denied",
  "cancelled",
  "unsettled",
  "unknown",
] as const;
export type TurnToolState = (typeof TURN_TOOL_STATES)[number];

// ─── Input ───────────────────────────────────────────────────────────────────

/** A step as the wire / `metadata.aiSteps` carries it. Extra fields are ignored. */
export interface TurnActivityStep extends ToolRunStep {
  toolInput?: unknown;
  /** ISO string on the wire and at rest; a Date in the browser's stream store. */
  timestamp?: string | Date;
  /** Producer-measured duration in ms, when it sent one. */
  duration?: number;
}

/**
 * Where a proposal filed during the turn now stands — the caller passes the
 * CANONICAL bucket (`proposalLifecycleBucket`, `@synap-core/proposal-types`),
 * which this leaf cannot import. Absent ⇒ still awaiting the person.
 */
export type TurnProposalBucket =
  | "pending"
  | "applied"
  | "rejected"
  | "withdrawn"
  | "reverted"
  | "expired"
  | "failed"
  | "unknown";

export interface TurnActivityInput {
  steps: readonly TurnActivityStep[];
  /** True while the turn is in flight (no complete / error event yet). */
  streaming: boolean;
  /** True once answer text has started — only refines `workingLabel`. */
  answering?: boolean;
  /** The turn's terminal error, if any. `cancelled` = the person pressed Stop. */
  error?: { message?: string; cancelled?: boolean } | null;
  /** Proposals the turn filed (the stream's `createdProposals`). */
  proposals?: readonly { proposalId: string }[];
  /** Current bucket per proposal id, when the caller has read it. */
  proposalBuckets?: Readonly<Record<string, TurnProposalBucket | undefined>>;
  /**
   * The caller's bucket read FAILED. A filed proposal with no bucket then reads
   * `unknown`, not `awaiting_approval` — empty and failed are different facts.
   */
  proposalBucketsUnavailable?: boolean;
  startedAt?: string | Date;
  completedAt?: string | Date;
  /** The clock, for a live turn's elapsed time. A parameter — this stays pure. */
  now?: Date;
}

// ─── Output ──────────────────────────────────────────────────────────────────

export interface TurnToolLabel {
  /** "Searching your pod" — while it runs. */
  progressive: string;
  /** "Searched your pod" — once it settled. */
  past: string;
}

export type TurnActivityItem =
  | { kind: "reasoning"; id: string; text: string }
  | {
      kind: "tool";
      /** The CALL step's id (an orphan result's own id) — stable across settle. */
      id: string;
      toolName: string;
      state: TurnToolState;
      label: TurnToolLabel;
      /** What it acted on, when the input names it ("q3 roadmap"). */
      target?: string;
      /** A result count or the failure reason (from `projectToolRuns`). */
      detail?: string;
      /** The proposal the call filed, when it filed one. */
      proposalId?: string;
      durationMs?: number;
    }
  | { kind: "error"; id: string; message: string };

export interface TurnSummary {
  /** Span of the agent's work (start → last step / completion). Null = unmeasured. */
  thinkingMs: number | null;
  toolCount: number;
  failedCount: number;
  /** Distinct proposals filed during the turn. */
  proposalCount: number;
  /** Tools whose proposal still waits on the person. */
  awaitingCount: number;
  reasoningCount: number;
}

export interface TurnActivity {
  phase: TurnPhase;
  items: TurnActivityItem[];
  summary: TurnSummary;
  /** Present-tense label of what it is doing now; null unless `working`. */
  workingLabel: string | null;
}

// ─── Reasoning noise ─────────────────────────────────────────────────────────
// Lifecycle chatter the agent emits as `thinking` steps. It says nothing a
// person can use, and the tool-shaped ones duplicate the tool rows. Moved here
// from ai-chat's AIStepsPanel so every surface hides the SAME steps.

const HIDDEN_REASONING_PREFIXES = [
  "assembling context",
  "initializing",
  "loading context",
  "preparing",
  "setting up",
  "context assembly",
];

const TOOL_REASONING_PATTERNS = [
  /^calling\s+/,
  /^executing\s+/,
  /^running\s+/,
  /^error\s+executing\s+/,
  /^failed\s+to\s+(call|execute|run)\s+/,
  /^tool\s+(call|execution|result)/,
  /^invok(e|ing)\s+/,
];

/** The text a reasoning row shows, or null when the step is noise / empty. */
function reasoningText(step: TurnActivityStep): string | null {
  const text = (step.title?.trim() || step.content?.trim()) ?? "";
  // Producers prefix emoji ("🧠 Assembling context...") — match past them.
  const key = text.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
  if (!key) return null;
  if (HIDDEN_REASONING_PREFIXES.some((p) => key.startsWith(p))) return null;
  if (TOOL_REASONING_PATTERNS.some((p) => p.test(key))) return null;
  return text;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ms(at: string | Date | undefined): number | null {
  if (at === undefined) return null;
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/** The proposal a tool result filed: `{ status: "proposed", proposalId }`. */
function filedProposal(output: unknown): { proposalId?: string } | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { status?: unknown; proposalId?: unknown };
  if (o.status !== "proposed") return null;
  return typeof o.proposalId === "string" ? { proposalId: o.proposalId } : {};
}

const TARGET_KEYS = ["query", "q", "title", "name", "url", "path"] as const;
const TARGET_MAX = 60;

/** What the call acted on, when its input names it in a plain string field. */
function targetOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      const s = v.trim().replace(/\s+/g, " ");
      return s.length > TARGET_MAX ? `${s.slice(0, TARGET_MAX - 1)}…` : s;
    }
  }
  return undefined;
}

function labelFor(
  toolName: string,
  step: TurnActivityStep | null
): TurnToolLabel {
  if (isKnownToolName(toolName)) {
    return {
      progressive: resolveToolLabel(toolName, "progressive"),
      past: resolveToolLabel(toolName, "past"),
    };
  }
  const authored = (step?.title?.trim() || step?.content?.trim())
    ?.replace(/[.…]+$/u, "")
    .trim();
  const fallback = resolveToolLabel(toolName);
  return { progressive: authored || fallback, past: authored || fallback };
}

function bucketState(
  bucket: TurnProposalBucket | undefined,
  unavailable: boolean
): TurnToolState {
  if (bucket === undefined) return unavailable ? "unknown" : "awaiting_approval";
  switch (bucket) {
    case "applied":
    case "reverted": // it DID apply; the undo is the proposal's story, not the tool's
      return "done";
    case "rejected":
    case "withdrawn":
    case "expired":
      return "denied";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
    default:
      return "awaiting_approval";
  }
}

// ─── The derivation ──────────────────────────────────────────────────────────

export function deriveTurnActivity(input: TurnActivityInput): TurnActivity {
  const steps = input.steps;
  const phase: TurnPhase = input.error
    ? input.error.cancelled
      ? "cancelled"
      : "failed"
    : input.streaming
      ? "working"
      : "complete";

  const pairs = pairToolRunSteps(steps);
  const cards = new Map(projectToolRuns(steps).map((c) => [c.id, c]));
  // Index each pair by the step that anchors it in the timeline: the call, or
  // an orphan result's own step.
  const pairAt = new Map(pairs.map((p) => [(p.call ?? p.result)!.id, p]));

  const items: TurnActivityItem[] = [];
  const proposalIds = new Set<string>();
  for (const p of input.proposals ?? []) proposalIds.add(p.proposalId);

  for (const step of steps) {
    const pair = pairAt.get(step.id);
    if (pair && (pair.call ?? pair.result) === step) {
      const { toolName, call, result } = pair;
      const anchor = (call ?? result)!;
      const card = cards.get(anchor.id);
      let state: TurnToolState;
      let proposalId: string | undefined;
      if (result) {
        const filed = toolRunResultFailed(result)
          ? null
          : filedProposal(result.toolOutput);
        if (filed) {
          proposalId = filed.proposalId;
          if (proposalId) proposalIds.add(proposalId);
          state = bucketState(
            proposalId ? input.proposalBuckets?.[proposalId] : undefined,
            input.proposalBucketsUnavailable === true
          );
        } else {
          state = card?.status === "failed" ? "failed" : "done";
        }
      } else if (call!.status === "error") {
        state = "failed";
      } else if (phase === "working") {
        state = call!.status === "pending" ? "pending" : "running";
      } else if (phase === "cancelled") {
        state = "cancelled";
      } else {
        state = "unsettled";
      }
      const start = ms(call?.timestamp);
      const end = ms(result?.timestamp);
      const durationMs =
        result?.duration ??
        (start !== null && end !== null && end >= start
          ? end - start
          : undefined);
      const target = targetOf(call?.toolInput);
      const detail = card?.detail;
      items.push({
        kind: "tool",
        id: anchor.id,
        toolName,
        state,
        label: labelFor(toolName, call ?? result),
        ...(target !== undefined ? { target } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(proposalId !== undefined ? { proposalId } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      continue;
    }
    if (step.type === "thinking") {
      const text = reasoningText(step);
      if (text) items.push({ kind: "reasoning", id: step.id, text });
      continue;
    }
    // An error step the pairing did not claim (no tool on it) is the turn's own.
    if (step.type === "error" && !step.toolName?.trim()) {
      items.push({
        kind: "error",
        id: step.id,
        message: step.error?.trim() || step.content?.trim() || "Failed",
      });
    }
  }

  const tools = items.filter(
    (i): i is Extract<TurnActivityItem, { kind: "tool" }> => i.kind === "tool"
  );

  // Span of the work: the turn's start (or its first step) → its completion,
  // else the clock while live, else the last step. Unmeasured stays null.
  const stamps = steps
    .map((s) => ms(s.timestamp))
    .filter((t): t is number => t !== null);
  const from =
    ms(input.startedAt) ?? (stamps.length ? Math.min(...stamps) : null);
  const to =
    ms(input.completedAt) ??
    (phase === "working" && input.now
      ? input.now.getTime()
      : stamps.length
        ? Math.max(...stamps)
        : null);
  const thinkingMs =
    from !== null && to !== null && to >= from ? to - from : null;

  const open = [...tools]
    .reverse()
    .find((t) => t.state === "running" || t.state === "pending");
  const workingLabel =
    phase !== "working"
      ? null
      : open
        ? open.label.progressive
        : input.answering
          ? "Writing"
          : "Thinking";

  return {
    phase,
    items,
    summary: {
      thinkingMs,
      toolCount: tools.length,
      failedCount: tools.filter((t) => t.state === "failed").length,
      proposalCount: proposalIds.size,
      awaitingCount: tools.filter((t) => t.state === "awaiting_approval")
        .length,
      reasoningCount: items.filter((i) => i.kind === "reasoning").length,
    },
    workingLabel,
  };
}

// ─── Summary line ────────────────────────────────────────────────────────────

/**
 * Compact elapsed time for the summary ("12s", "3m", "1h 5m"). Local because
 * the types package has no duration formatter and value formatting is NOT
 * vocabulary (vocabulary.md); fold it into the formatting SSOT when one exists.
 */
function compactDuration(totalMs: number): string {
  const s = Math.max(1, Math.round(totalMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * The collapsed trace's one line, from summary DATA:
 *   "Thought 12s · ran 3 tools · 1 failed · 2 proposals"
 * Empty string when there is nothing to say (no time, no tools, no proposals) —
 * the caller omits the line, never renders an empty shell.
 */
export function formatTurnSummary(summary: TurnSummary): string {
  const bits: string[] = [];
  if (summary.thinkingMs !== null)
    bits.push(`thought ${compactDuration(summary.thinkingMs)}`);
  if (summary.toolCount > 0) {
    const ran = resolveActionLabel("run", "past").toLowerCase();
    bits.push(
      `${ran} ${summary.toolCount} ${summary.toolCount === 1 ? "tool" : "tools"}`
    );
  }
  if (summary.failedCount > 0) {
    bits.push(
      `${summary.failedCount} ${resolveStatusLabel("failed").toLowerCase()}`
    );
  }
  if (summary.proposalCount > 0) {
    const noun =
      summary.proposalCount === 1
        ? resolveObjectNoun("proposal")
        : resolveObjectNounPlural("proposal");
    bits.push(`${summary.proposalCount} ${noun.toLowerCase()}`);
  }
  const line = bits.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
}

// ─── Marks ───────────────────────────────────────────────────────────────────

export type TurnMarkState = TurnPhase | TurnToolState;

/**
 * ONE mark table for a turn and its tools — tone + glyph, never a colour and
 * never a sentence. Reuses the run side's step marks (./marks.ts) so a tool row
 * and a session step that mean the same thing wear the same mark. TOTAL over
 * both vocabularies: a new state without a mark stops the build.
 *
 * AI yellow marks ONLY live work (`working`, `running`). A failure is never AI.
 */
const TURN_MARKS = {
  working: stepMark("now"),
  running: stepMark("now"),
  // Queued, not yet live: muted, so the AI colour stays the "happening now" mark.
  pending: { tone: "textMuted", glyph: "clock" },
  complete: stepMark("done"),
  done: stepMark("done"),
  // Same mark as a run step waiting on you: your turn.
  awaiting_approval: stepMark("waiting_on_you"),
  failed: stepMark("failed"),
  denied: stepMark("declined"),
  // Stopped by the person: did not happen, not a fault.
  cancelled: stepMark("declined"),
  unsettled: stepMark("unsettled"),
  // Its proposal's standing could not be read — a question, not "your turn".
  unknown: stepMark("unsettled"),
} as const satisfies Record<TurnMarkState, StepMark>;

export function turnMark(state: TurnMarkState): {
  tone: UnitTone;
  glyph: UnitGlyph;
} {
  return TURN_MARKS[state];
}
