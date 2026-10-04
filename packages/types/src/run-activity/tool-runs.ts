/**
 * TOOL RUNS — what the AI DID in one turn, projected out of its `step` events.
 * THE one projection, for every consumer:
 *
 *   - the pod (`loadSessionActivity`, the session Activity read) — over the
 *     durable `chat_turn_events` journal;
 *   - relay's chat (`useAIChat` → `AIToolRunList`) — over the live SSE turn;
 *   - the browser's chat (`toMessageParts` in `@synap-core/channels`) — which
 *     reads the settled status off it so a finished call stops reading as running.
 *
 * It lived in relay (`src/lib/ai-tool-runs.ts`) until 2026-10-04 while the
 * browser paired a call with its result by matching ids that never match
 * (`tool-call-3-…` vs `tool-result-3-…`), so every finished tool call kept its
 * running row until the turn ended. Moving it here is what makes that one rule.
 *
 * ── Where steps come from ─────────────────────────────────────────────────
 * The IS emits one step per tool call and per tool result
 * (`agents/base/ai-step-factory.ts`), the pod re-broadcasts them
 * (`channels/send-message.ts` → `AI_STEP`), the sequencer frames and journals
 * them (`utils/chat-turn-sse.ts`, `type: "step"`).
 *
 * ── Scope: tools, not thoughts ────────────────────────────────────────────
 * Only `tool_call` / `tool_result` / a tool-attributed `error` become cards.
 * `thinking` steps are deliberately excluded (decision D3, 2026-10-04: agent
 * reasoning is hidden at rest).
 *
 * ── Labels ────────────────────────────────────────────────────────────────
 * NO local label map. The step's own `title` / `content` is server-authored and
 * already friendly ("Searching your workspace…"); when it is absent the tool's
 * machine name goes through `humanizeToken`, the vocabulary SSOT.
 *
 * ── Pairing ───────────────────────────────────────────────────────────────
 * A call and its result are separate steps with DIFFERENT ids and NO shared
 * call id — not on the wire and not in the durable journal — so they are paired
 * FIFO on `toolName`: a result settles the OLDEST still-running card for that
 * tool. Exact for sequential tool use, which is what the agent does today. Two
 * *simultaneous* calls to the SAME tool could settle in the wrong order — two
 * cards carrying the same label swap, a cosmetic miss, not a wrong claim. Ids
 * are NOT parsed for a step number; depending on a producer's id format is a
 * fork waiting to happen.
 */

import { humanizeToken } from "../vocabulary/index.js";

/** The step fields this projection reads. Everything else is ignored. */
export interface ToolRunStep {
  id: string;
  type: string;
  content?: string;
  title?: string;
  toolName?: string;
  toolOutput?: unknown;
  status?: string;
  error?: string;
}

export type ToolRunStatus = "running" | "done" | "failed";

export interface ToolRunCard {
  /** Stable across the call→result transition: the CALL step's id. */
  id: string;
  toolName: string;
  label: string;
  status: ToolRunStatus;
  /** One short line under the label — a result count, or the error. */
  detail?: string;
}

/**
 * The label for a step, best source first.
 *
 * `title` and `content` come from the producer and read as sentences
 * ("Searching your workspace…"). The trailing ellipsis belongs to the RUNNING
 * state, which the card renders itself, so it is stripped rather than baked
 * into a label that will outlive it.
 */
function labelFor(step: ToolRunStep, toolName: string): string {
  const raw = step.title?.trim() || step.content?.trim();
  if (raw) return raw.replace(/[.…]+$/u, "").trim() || humanizeToken(toolName);
  return humanizeToken(toolName);
}

/**
 * How many things a tool returned, when that is knowable.
 *
 * Deliberately narrow. An array's length is a real count; a bare object is
 * "1 result" only in the producer's own phrasing, and inventing a number for
 * an arbitrary payload is the kind of confident-and-wrong detail this app has
 * been bitten by. Anything else gets no detail line at all.
 */
function detailFor(output: unknown): string | undefined {
  if (Array.isArray(output)) {
    return output.length === 1 ? "1 result" : `${output.length} results`;
  }
  if (output && typeof output === "object") {
    const results = (output as { results?: unknown }).results;
    if (Array.isArray(results)) {
      return results.length === 1 ? "1 result" : `${results.length} results`;
    }
  }
  return undefined;
}

/**
 * Fold an ordered list of turn steps into the cards to render.
 *
 * Order is CALL order — the sequence the agent actually worked in — and a
 * result never moves a card, it only settles one in place.
 */
export function projectToolRuns(steps: readonly ToolRunStep[]): ToolRunCard[] {
  const cards: ToolRunCard[] = [];

  const settleOldest = (
    toolName: string,
    next: Omit<ToolRunCard, "id" | "toolName" | "label">
  ): boolean => {
    const target = cards.find(
      (c) => c.toolName === toolName && c.status === "running"
    );
    if (!target) return false;
    target.status = next.status;
    if (next.detail !== undefined) target.detail = next.detail;
    return true;
  };

  for (const step of steps) {
    const toolName = step.toolName?.trim();
    if (!toolName) continue;

    if (step.type === "tool_call") {
      cards.push({
        id: step.id,
        toolName,
        label: labelFor(step, toolName),
        status: step.status === "error" ? "failed" : "running",
        ...(step.error ? { detail: step.error } : {}),
      });
      continue;
    }

    if (step.type === "tool_result" || step.type === "error") {
      const failed = step.type === "error" || step.status === "error";
      const settled = {
        status: (failed ? "failed" : "done") as ToolRunStatus,
        detail: failed
          ? step.error?.trim() || "Failed"
          : detailFor(step.toolOutput),
      };
      if (settleOldest(toolName, settled)) continue;
      // A result with no matching call — the call frame was dropped, or the
      // stream was joined mid-turn. Showing the result on its own is strictly
      // better than showing nothing: the tool DID run.
      cards.push({
        id: step.id,
        toolName,
        label: labelFor(step, toolName),
        ...settled,
      });
    }
  }

  return cards;
}

/**
 * Merge a newly-arrived step into an accumulated list.
 *
 * `useAIChat` receives steps one event at a time, and a `step` event may
 * REPLACE an earlier one with the same id (the shared reducer's own semantics
 * in `turn-events.ts`). Replaying the whole list through `projectToolRuns`
 * keeps exactly one place that decides what a card is.
 */
export function appendToolRunStep(
  steps: readonly ToolRunStep[],
  incoming: ToolRunStep
): ToolRunStep[] {
  const index = steps.findIndex((s) => s.id === incoming.id);
  if (index === -1) return [...steps, incoming];
  const next = steps.slice();
  next[index] = incoming;
  return next;
}
