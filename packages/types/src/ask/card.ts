/**
 * The ASK CARD's rules — what relay and the browser both draw for an owed slot
 * that carries an ask. Pure, dependency-light, shared: a surface may arrange
 * these for its own screen, but it may not re-derive them (CLAUDE.md: surfaces
 * never fork a RULE).
 *
 * Each rule below replaced two local copies that had already drifted:
 *   · {@link askSlotStanding}   — relay showed an old receipt on a re-asked slot
 *   · {@link classifyAskRefusal} — the browser leaked a bare `ask_changed:` code
 *   · {@link askRowRegion}      — relay drew "Answer…" on a provide nobody can
 *                                 answer yet
 *   · {@link actView}           — relay dropped a padded url instead of trimming
 *   · {@link ASK_COPY}          — the two copy tables said different words
 */

import { isHttpUrl } from "../navigation/index.js";
import {
  ASK_CHANGED_PREFIX,
  askAnswersInline,
  askOptionKey,
  askRefusalIsStale,
  resolveAskResolution,
  type Ask,
  type AskOption,
} from "./index.js";

// ─── Copy ───────────────────────────────────────────────────────────────────

/**
 * The card's words, ONCE for both surfaces. Product copy, not vocabulary: none
 * of these names a value the pod stores. "Yes" / "No" are `summarizeAnswer`'s
 * own receipt words, so the button pressed and the receipt read back agree.
 * No em dashes in visible copy.
 */
export const ASK_COPY = {
  yes: "Yes",
  no: "No",
  didThis: "I did this",
  notMine: "Not mine",
  talk: "Talk it through",
  answerDoor: "Answer…",
  notePlaceholder: "A note for the agent (optional)",
  movedOn: "This one moved on",
  askChanged: "The question changed. Check your answer.",
  failedTitle: "Didn't go through",
  doneByYou: "Done by you",
  /** The surface appends " · {age}" itself. */
  youAnswered: (answer: string): string => `You answered: ${answer}`,
  agentHasIt: "The agent has it back.",
  /**
   * The heading over an ask's `lookedAt` — the objects the agent read before
   * asking (trust-ladder rung 1). The agent speaks, so it is first person.
   */
  lookedAt: "What I looked at",
  provideTitle: "Not answerable here yet",
  provideBody: "Talk it through with the agent.",
  /**
   * The needs-you row for an undecided agent draft that asks the person
   * something (`draft-asks` signal). Composed ONCE, server-side, into the
   * signal's `title`; `agent` is null when the pod cannot name who started it.
   */
  draftAsks: (agent: string | null, work: string, asks: number): string =>
    `${agent?.trim() || "An agent"} started ${work} · asks you ${
      asks === 1 ? "1 thing" : `${asks} things`
    }`,
} as const;

// ─── Where the slot stands ──────────────────────────────────────────────────

/** The slot fields the standing reads — structural, off `pendingExpected`. */
export interface AskSlotLite {
  owner?: "human" | "agent" | null;
  status?: string | null;
  retiredAt?: string | null;
  attestedAt?: string | null;
  answer?: { text?: string | null } | null;
}

/**
 *   `owed`     — the reader's to answer now.
 *   `answered` — they answered; the agent has it back (receipt).
 *   `attested` — they said "I did this" (receipt).
 *   `gone`     — no such slot, retired, or done with nothing of theirs on it.
 */
export type AskSlotStanding = "owed" | "answered" | "attested" | "gone";

/**
 * Order is the rule:
 *  1. attested before everything live: attest stamps `status: 'done'` AND
 *     keeps `owner: 'human'`, and a done slot cannot be re-blocked.
 *  2. owed BEFORE answered: the answer door hands the slot back WITH the answer
 *     on it, so a slot the agent re-asked (owner back to `human`) still carries
 *     the old answer. Reading the answer first showed that old receipt on a
 *     question the person has not answered yet.
 *  3. answered even when the agent then closed the slot (`done`): an answered
 *     slot never reads "moved on".
 */
export function askSlotStanding(
  slot: AskSlotLite | null | undefined
): AskSlotStanding {
  if (!slot || slot.retiredAt) return "gone";
  if (slot.attestedAt) return "attested";
  if (slot.owner === "human" && slot.status !== "done") return "owed";
  if (slot.answer?.text?.trim()) return "answered";
  return "gone";
}

// ─── A refusal, read ────────────────────────────────────────────────────────

/**
 *   `failed`      — an ordinary refusal: banner, draft kept, retry.
 *   `ask_changed` — the agent changed the ask: refetch, re-render, keep draft.
 *   `moved_on`    — the slot is no longer the reader's: explain + session door.
 */
export type AskRefusalKind = "failed" | "ask_changed" | "moved_on";
export interface AskRefusal {
  kind: AskRefusalKind;
  /** Words for a person — never a machine code. */
  message: string;
}

const ASK_CODE_PREFIX = /^ask_[a-z_]+:\s*/;

const REFUSAL_FALLBACK: Record<AskRefusalKind, string> = {
  failed: ASK_COPY.failedTitle,
  ask_changed: ASK_COPY.askChanged,
  moved_on: ASK_COPY.movedOn,
};

/**
 * How many "What I looked at" refs a card shows inline before "+N" — and "+N"
 * is a DOOR to the ask page, which lists them all (relay's value, adopted by
 * both apps). The pod stores at most `ASK_LIMITS.lookedAtMax` (8).
 */
export const LOOKED_AT_ROW_CAP = 2;

/**
 * Staleness is `askRefusalIsStale`; only its two stale shapes are split here,
 * off the pod's `ask_changed:` prefix. The `ask_…:` code is stripped, and a
 * message that was ONLY the code reads as the kind's copy, never the code.
 */
export function classifyAskRefusal(
  message: string | null | undefined
): AskRefusal {
  const raw = typeof message === "string" ? message : "";
  const kind: AskRefusalKind = !askRefusalIsStale(raw)
    ? "failed"
    : raw.startsWith(ASK_CHANGED_PREFIX)
      ? "ask_changed"
      : "moved_on";
  const words = raw.replace(ASK_CODE_PREFIX, "").trim();
  return { kind, message: words || REFUSAL_FALLBACK[kind] };
}

// ─── Which region a row draws ───────────────────────────────────────────────

/**
 *   `legacy` — no ask: today's "I did this" · "Not mine".
 *   `act`    — the same pair, through the attest door (steps/url on detail).
 *   `inline` — a confirm, or a choose small enough to answer in place.
 *   `detail` — "Answer…" opens the ask's own page (form, wide choose, or a
 *              host that wired no inline answer runner).
 *   `none`   — `provide`: nothing here can hand it over yet, so NO answer
 *              door; the row offers "Talk it through" · "Not mine" only.
 */
export type AskRowRegion = "legacy" | "act" | "inline" | "detail" | "none";

export function askRowRegion(
  ask: Ask | null | undefined,
  options: { canAnswer: boolean }
): AskRowRegion {
  const resolution = resolveAskResolution(ask);
  if (!ask || resolution === "legacy") return "legacy";
  if (resolution === "attest") return "act";
  if (ask.mode === "provide") return "none";
  return options.canAnswer && askAnswersInline(ask) ? "inline" : "detail";
}

// ─── Choose: options ↔ capture chips ────────────────────────────────────────

/**
 * An option as capture's follow-up chip (`FollowUpChipSchema`, `../capture`) —
 * so the ONE choose renderer draws both. `value` is `askOptionKey`, the
 * identity the pod matches an answer on; `action: 'confirm'` is the chip's
 * plain "this answers it" arm (capture's apply verbs never apply to an ask).
 */
export interface AskOptionChip {
  label: string;
  value: string;
  action: "confirm";
  icon?: string;
  recommended?: true;
  description?: string;
}

export function askOptionChips(ask: Ask | null | undefined): AskOptionChip[] {
  if (!ask || ask.mode !== "choose") return [];
  return ask.options.map((o) => ({
    label: o.label,
    value: askOptionKey(o),
    action: "confirm" as const,
    ...(o.icon ? { icon: o.icon } : {}),
    ...(o.recommended ? { recommended: true as const } : {}),
    ...(o.description ? { description: o.description } : {}),
  }));
}

/** The OFFERED option a chip stands for, or `null` when it is not one. */
export function askOptionForChip(
  ask: Ask | null | undefined,
  chip: { value: string }
): AskOption | null {
  if (!ask || ask.mode !== "choose") return null;
  return ask.options.find((o) => askOptionKey(o) === chip.value) ?? null;
}

// ─── Act: where to go and what to do ────────────────────────────────────────

export interface ActView {
  /** A trimmed http(s) url, or `null`. Never any other scheme. */
  url: string | null;
  /** The url's host, for "Open <host>". */
  host: string | null;
  /** The steps, trimmed, blanks dropped. */
  steps: string[];
}

export function actView(ask: Ask | null | undefined): ActView | null {
  if (!ask || ask.mode !== "act") return null;
  const trimmed = ask.url?.trim();
  const url = trimmed && isHttpUrl(trimmed) ? trimmed : null;
  return {
    url,
    host: url ? new URL(url).host || null : null,
    steps: (ask.steps ?? []).map((s) => s.trim()).filter(Boolean),
  };
}
