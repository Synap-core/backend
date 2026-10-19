/**
 * The NEEDS-YOU CONTEXT STRIP — the four lines both needs-you pages (an owed
 * slot's page and a proposal's page) draw under their title, on both surfaces:
 *
 *   Unblocks   — the outcome answering satisfies, and the step it belongs to
 *   Meanwhile  — what the agent works on while it waits
 *   Looked at  — what the agent read to form the ask
 *   From       — the session (and its track step) it came from
 *
 * TWO adapters, ONE output: {@link needsYouContextFromOwedSlot} and
 * {@link needsYouContextFromProposal} read the shapes the pod already returns
 * and fill {@link NeedsYouContext}. A fact no read carries is `null` (or `[]`),
 * never guessed — the surface OMITS that line. A line whose read FAILED is named
 * in `unreadable`, so a surface never draws a failed read as an absent fact.
 *
 * What each read carries today (measured 2026-10-11):
 *   · `focusSessions.outputs` — `inputs[]` (each `blocksOutcomeKey`) and
 *     `outcomes[]` (label, `stageKey`), and the slots' `ask.lookedAt` NAMED
 *     through the reader's access floor.
 *   · `focusSessions.get` — `stages` (the session's own phases, `{key,name}`),
 *     `trackStage` (a KEY only — the track's stage NAME is not on this read),
 *     `continuation.session.displayTitle`, `continuation.aiCanDo`.
 *   · `proposals.get` — `sessionId`, `sessionGoal` (the session's display
 *     name), `sessionPrivate`, and `data.expectedKey` / `data.expectedLabel`
 *     when it claims a declared slot. NO `lookedAt`: a proposal carries none.
 *
 * Pure; reads its inputs structurally so neither app needs a cast.
 */

import { LOOKED_AT_ROW_CAP } from "../ask/card.js";
import { normalizeSlotLabel } from "../units/outcome.js";
import { humanizeToken } from "../vocabulary/index.js";

// ─── Output ────────────────────────────────────────────────────────────────

export interface NeedsYouContextStep {
  key: string;
  name: string;
}

export interface NeedsYouContextUnblocks {
  /** The outcome's key — a criterion key or a slot key. */
  criterionKey: string;
  /** The outcome in words. */
  label: string;
  /** The step it belongs to; `null` when no read names one. */
  step: NeedsYouContextStep | null;
  /** The session that owns the outcome — the line's door. */
  sessionId: string;
}

export interface NeedsYouContextRef {
  kind: string;
  id: string;
  /** Server-resolved name; `null` when the object has none. */
  title: string | null;
}

export interface NeedsYouContextFrom {
  sessionId: string;
  title: string;
  /** The track step the session was filed at; `null` off a track. */
  step: NeedsYouContextStep | null;
}

/** A line whose read FAILED — distinct from a line whose fact is absent. */
export type NeedsYouContextLine = "unblocks" | "meanwhile" | "from";

export interface NeedsYouContext {
  unblocks: NeedsYouContextUnblocks | null;
  meanwhile: string | null;
  /** Capped at {@link LOOKED_AT_ROW_CAP}; `lookedAtTotal` counts them all. */
  lookedAt: NeedsYouContextRef[];
  lookedAtTotal: number;
  from: NeedsYouContextFrom | null;
  unreadable: NeedsYouContextLine[];
}

/** The strip's line headings — product copy, ONCE for both surfaces. */
export const NEEDS_YOU_CONTEXT_COPY = {
  unblocks: "Unblocks",
  meanwhile: "Meanwhile",
  lookedAt: "Looked at",
  from: "From",
} as const;

// ─── Inputs (structural) ───────────────────────────────────────────────────

/** `focusSessions.outputs` — the fields this reads. */
export interface NeedsYouOutputsRead {
  outcomes?: ReadonlyArray<{
    key: string;
    label: string;
    stageKey?: string | null;
    slotLabel?: string | null;
    retired?: boolean;
  }> | null;
  inputs?: ReadonlyArray<{
    key: string;
    slotLabel: string;
    blocksOutcomeKey: string | null;
  }> | null;
}

/** `focusSessions.get` — the fields this reads. */
export interface NeedsYouSessionRead {
  id: string;
  /** `continuation.session.displayTitle` (or any resolved session name). */
  title?: string | null;
  /** The session's own phases (`stages` column, `PlaybookStage[]`). */
  stages?: unknown;
  /** The track stage KEY the session was filed at. */
  trackStage?: string | null;
  /**
   * The track's stages, when the caller has read the track — the session read
   * carries only the key. Absent ⇒ the key is humanized.
   */
  trackStages?: ReadonlyArray<{ key: string; name?: string | null }> | null;
}

/** `continuation.aiCanDo` — a packet section. */
export type NeedsYouAiCanDoRead =
  | { status: "ok"; items: ReadonlyArray<{ label: string }> }
  | { status: "unavailable"; reason?: string }
  | null
  | undefined;

/** A read the surface made — the value, or that it failed. */
export type NeedsYouRead<T> =
  { status: "ok"; value: T } | { status: "unavailable" } | null | undefined;

export interface OwedSlotContextInput {
  /** The owed slot (from `pendingExpected` / `inputs`). */
  slot: {
    label: string;
    ask?: {
      lookedAt?: ReadonlyArray<{
        kind: string;
        id: string;
        title?: string | null;
      }> | null;
    } | null;
  };
  outputs: NeedsYouRead<NeedsYouOutputsRead>;
  session: NeedsYouRead<NeedsYouSessionRead>;
  aiCanDo?: NeedsYouAiCanDoRead;
}

export interface ProposalContextInput {
  /** `proposals.get` — the fields this reads. */
  proposal: {
    sessionId?: string | null;
    sessionGoal?: string | null;
    sessionPrivate?: boolean | null;
    data?: unknown;
  };
  /** The proposal's session's outputs read; omit when it has no session. */
  outputs?: NeedsYouRead<NeedsYouOutputsRead>;
  session?: NeedsYouRead<NeedsYouSessionRead>;
  aiCanDo?: NeedsYouAiCanDoRead;
}

// ─── Shared steps ──────────────────────────────────────────────────────────

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stepFrom(
  key: string | null | undefined,
  named: unknown
): NeedsYouContextStep | null {
  const k = text(key);
  if (!k) return null;
  const list = Array.isArray(named) ? named : [];
  const hit = list.find(
    (s): s is { key: string; name?: unknown } =>
      !!s && typeof s === "object" && (s as { key?: unknown }).key === k
  );
  return { key: k, name: text(hit?.name) ?? humanizeToken(k) };
}

/** The outcome's own phase first, else the session's track step. */
function unblocksStep(
  outcomeStageKey: string | null | undefined,
  session: NeedsYouSessionRead | null
): NeedsYouContextStep | null {
  if (text(outcomeStageKey)) return stepFrom(outcomeStageKey, session?.stages);
  return session ? stepFrom(session.trackStage, session.trackStages) : null;
}

function meanwhileOf(
  aiCanDo: NeedsYouAiCanDoRead,
  exceptLabel: string | null
): { value: string | null; failed: boolean } {
  if (!aiCanDo) return { value: null, failed: false };
  if (aiCanDo.status !== "ok") return { value: null, failed: true };
  const skip = normalizeSlotLabel(exceptLabel);
  const item = aiCanDo.items.find(
    (i) => text(i.label) && normalizeSlotLabel(i.label) !== skip
  );
  return { value: item ? text(item.label) : null, failed: false };
}

function fromOf(
  sessionId: string,
  title: string | null,
  session: NeedsYouSessionRead | null
): NeedsYouContextFrom | null {
  if (!title) return null;
  return {
    sessionId,
    title,
    step: session ? stepFrom(session.trackStage, session.trackStages) : null,
  };
}

function ok<T>(read: NeedsYouRead<T>): T | null {
  return read && read.status === "ok" ? read.value : null;
}

function failed<T>(read: NeedsYouRead<T>): boolean {
  return !!read && read.status === "unavailable";
}

// ─── Adapters ──────────────────────────────────────────────────────────────

/**
 * An owed slot's strip. Unblocks follows the slot's own input to the outcome
 * it blocks (`blocksOutcomeKey`, the one projection) — and is OMITTED when
 * that outcome is the slot itself (an ordinary decision slot blocks its own
 * deliverable: "Unblocks" would restate the title).
 */
export function needsYouContextFromOwedSlot(
  input: OwedSlotContextInput
): NeedsYouContext {
  const outputs = ok(input.outputs);
  const session = ok(input.session);
  const unreadable: NeedsYouContextLine[] = [];
  const sessionId = session?.id ?? null;

  let unblocks: NeedsYouContextUnblocks | null = null;
  if (failed(input.outputs)) unreadable.push("unblocks");
  else if (outputs && sessionId) {
    const want = normalizeSlotLabel(input.slot.label);
    const slotInput = (outputs.inputs ?? []).find(
      (i) => normalizeSlotLabel(i.slotLabel) === want
    );
    const target = slotInput?.blocksOutcomeKey ?? null;
    const outcome =
      target && target !== slotInput?.key
        ? (outputs.outcomes ?? []).find((o) => o.key === target && !o.retired)
        : undefined;
    if (outcome) {
      unblocks = {
        criterionKey: outcome.key,
        label: outcome.label,
        step: unblocksStep(outcome.stageKey, session),
        sessionId,
      };
    }
  }

  const meanwhile = meanwhileOf(input.aiCanDo, input.slot.label);
  if (meanwhile.failed) unreadable.push("meanwhile");

  if (failed(input.session)) unreadable.push("from");
  const from = sessionId
    ? fromOf(sessionId, text(session?.title), session)
    : null;

  const refs = (input.slot.ask?.lookedAt ?? []).map((r) => ({
    kind: r.kind,
    id: r.id,
    title: text(r.title),
  }));

  return {
    unblocks,
    meanwhile: meanwhile.value,
    lookedAt: refs.slice(0, LOOKED_AT_ROW_CAP),
    lookedAtTotal: refs.length,
    from,
    unreadable,
  };
}

/**
 * A proposal's strip. Unblocks is the declared slot the proposal claims
 * (`data.expectedKey`, else `data.expectedLabel` — the same key-then-label
 * order every pod slot door uses). A proposal from a session the viewer may
 * not read (`sessionPrivate`) has no From and no Unblocks: seeing a proposal
 * never names its session.
 */
export function needsYouContextFromProposal(
  input: ProposalContextInput
): NeedsYouContext {
  const p = input.proposal;
  const sessionId = p.sessionPrivate ? null : text(p.sessionId);
  const outputs = ok(input.outputs);
  const session = ok(input.session);
  const unreadable: NeedsYouContextLine[] = [];

  const data =
    p.data && typeof p.data === "object"
      ? (p.data as { expectedKey?: unknown; expectedLabel?: unknown })
      : {};

  let unblocks: NeedsYouContextUnblocks | null = null;
  if (sessionId && failed(input.outputs)) unreadable.push("unblocks");
  else if (sessionId && outputs) {
    const key = text(data.expectedKey);
    const label = normalizeSlotLabel(text(data.expectedLabel));
    const live = (outputs.outcomes ?? []).filter((o) => !o.retired);
    const outcome =
      (key ? live.find((o) => o.key === key) : undefined) ??
      (label
        ? live.find((o) => normalizeSlotLabel(o.slotLabel) === label)
        : undefined);
    if (outcome) {
      unblocks = {
        criterionKey: outcome.key,
        label: outcome.label,
        step: unblocksStep(outcome.stageKey, session),
        sessionId,
      };
    }
  }

  const meanwhile = sessionId
    ? // The slot this proposal delivers is not "meanwhile" work.
      meanwhileOf(input.aiCanDo, text(data.expectedLabel))
    : { value: null, failed: false };
  if (meanwhile.failed) unreadable.push("meanwhile");

  if (sessionId && failed(input.session)) unreadable.push("from");
  const from = sessionId
    ? fromOf(sessionId, text(session?.title) ?? text(p.sessionGoal), session)
    : null;

  return {
    unblocks,
    meanwhile: meanwhile.value,
    lookedAt: [],
    lookedAtTotal: 0,
    from,
    unreadable,
  };
}
