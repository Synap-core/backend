/**
 * The ASK CARD's rules — what relay and the browser both draw for an owed slot
 * that carries an ask. Pure, dependency-light, shared: a surface may arrange
 * these for its own screen, but it may not re-derive them (CLAUDE.md: surfaces
 * never fork a RULE).
 *
 * Each rule below replaced two local copies that had already drifted:
 *   · {@link askSlotStanding}   — relay showed an old receipt on a re-asked slot
 *   · {@link classifyAskRefusal} — the browser leaked a bare `ask_changed:` code
 *   · {@link askRowRegion}      — relay drew "Answer…" on a provide its host
 *                                 could not answer
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
  type AskProvideKind,
  type AskSnapshot,
  type ProvideConnectUnavailableReason,
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
  /**
   * The mark on an answered choose whose ask carried an AI recommendation
   * ({@link askRecommendationOutcome}). Nothing is drawn for `none`.
   */
  followedAiPick: "Followed AI pick",
  choseDifferently: "Chose differently from AI",
  /** The overrode mark's detail line, when the recommended option is known. */
  aiPicked: (label: string): string => `AI picked: ${label}`,
  /** A provide this host has not wired (`askRowRegion` → `none`). */
  provideTitle: "Not answerable here yet",
  provideBody: "Talk it through with the agent.",
  /** Provide, connection: start a new connection to the asked service. */
  provideConnect: (service: string): string => `Connect ${service}`,
  /** Provide, connection: hand over one the person already has. */
  provideUseExisting: "Use an account you already connected",
  /** Provide, connection: several accounts, so the person picks one. */
  provideWhichAccount: "Which account?",
  /** Provide, connection: why a new connection can't start from this pod. */
  provideConnectUnavailable: (
    reason: ProvideConnectUnavailableReason,
    service: string
  ): string => {
    switch (reason) {
      case "no_broker":
        return "This pod can't connect accounts yet. A pod admin sets that up.";
      case "not_offered":
        return `This pod does not offer a ${service} connection yet. A pod admin can add it.`;
      default:
        return "Couldn't check which connections this pod offers. Try again in a moment.";
    }
  },
  /** Provide, connection: an account every member of the pod can use. */
  provideAccountShared: "Shared with the pod",
  /** Provide, connection: an account that is signed out (never handed over). */
  provideAccountNeedsSignIn: "Needs signing in again",
  /** Provide, connection: the connect flow is open somewhere else. */
  provideWaitingForConnection: (service: string): string =>
    `Finish connecting ${service}. This answers itself when it is done.`,
  /** Provide, file. */
  provideUpload: "Upload a file",
  provideLandsIn: (space: string): string => `It will be saved in ${space}.`,
  /** Provide, secret: pick one already in the person's vault. */
  providePickSecret: "Pick a secret from your vault",
  /** Provide, secret: type a new one (only where the host may author it). */
  provideAddSecret: "Add the secret",
  /** Provide, secret, on a host that never takes a new secret (the console). */
  provideAddSecretInApp:
    "New secrets are added in the Synap app, never typed here.",
  /** Provide, secret: what handing it over lets the asking agent do. */
  provideGrantNote: (agent: string, minutes: number): string =>
    `${agent} will be able to read it for ${minutes} minutes, in this session only.`,
  /** Provide, secret: the pod could not tell which agent asked. */
  provideNoGrantNote:
    "No agent will be able to read it yet. The agent has to ask for access.",
  /**
   * Provide, secret, after the answer: the agent asking is no longer the one
   * the person was shown (`secretGrant` refused `agent_changed`), so the pod
   * gave nobody a read of it.
   */
  provideAgentChangedTitle: "No agent can read your secret yet",
  provideAgentChangedBody:
    "The agent working on this changed. Reopen it to see who gets access.",
  /** Provide, file: the answer was refused after the upload, which stays. */
  provideUploadKept: (space: string): string =>
    `The file was saved in ${space}, but it wasn't handed over.`,
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
 *   `none`   — a `provide` this host has not wired: NO answer door; the row
 *              offers "Talk it through" · "Not mine" only.
 *
 * A `provide` always answers on its own sheet (`detail`) — a picker, a connect
 * flow or an upload never fits in a row — and only where the host DECLARES it
 * can hand that kind over (`canProvide`). A host that declares nothing keeps
 * `none`, so a client built before provide answers changes nothing.
 */
export type AskRowRegion = "legacy" | "act" | "inline" | "detail" | "none";

export interface AskRowRegionOptions {
  canAnswer: boolean;
  /** The provide kinds this host can hand over. Absent ⇒ none of them. */
  canProvide?: Partial<Record<AskProvideKind, boolean>>;
}

export function askRowRegion(
  ask: Ask | null | undefined,
  options: AskRowRegionOptions
): AskRowRegion {
  const resolution = resolveAskResolution(ask);
  if (!ask || resolution === "legacy") return "legacy";
  if (resolution === "attest") return "act";
  if (ask.mode === "provide") {
    return options.canProvide?.[ask.provide.kind] === true ? "detail" : "none";
  }
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

// ─── Followed or overrode the AI's pick ─────────────────────────────────────

/**
 *   `followed` — the person picked the option the agent recommended.
 *   `overrode` — the agent recommended one, the person answered otherwise
 *                (another option, or "Other…" in their own words).
 *   `none`     — nothing to judge: no recommendation (a confirm can never
 *                carry one — only a choose's options can be `recommended`),
 *                or a pick nobody can read (a room reply in words).
 */
export type AskRecommendationOutcomeKind = "followed" | "overrode" | "none";

export interface AskRecommendationOutcome {
  outcome: AskRecommendationOutcomeKind;
  /** The recommended option's label, ONLY when `overrode` and it is known. */
  recommendedLabel: string | null;
}

/**
 * The ONE reading of `askSnapshot.followedRecommendation` for both surfaces.
 * Takes the snapshot itself, or an answer carrying it (`SlotAnswer`). The
 * pod's `null` stays `none` — never "overrode" advice nobody gave.
 */
export function askRecommendationOutcome(
  input: AskSnapshot | { askSnapshot?: AskSnapshot | null } | null | undefined
): AskRecommendationOutcome {
  const none: AskRecommendationOutcome = {
    outcome: "none",
    recommendedLabel: null,
  };
  if (!input) return none;
  const snap: AskSnapshot | null | undefined =
    "followedRecommendation" in input
      ? (input as AskSnapshot)
      : (input as { askSnapshot?: AskSnapshot | null }).askSnapshot;
  if (!snap || snap.mode !== "choose" || !snap.recommendedKey) return none;
  if (snap.followedRecommendation === true)
    return { outcome: "followed", recommendedLabel: null };
  if (snap.followedRecommendation !== false) return none;
  const rec = snap.options?.find(
    (o) => askOptionKey(o) === snap.recommendedKey
  );
  return { outcome: "overrode", recommendedLabel: rec?.label ?? null };
}
