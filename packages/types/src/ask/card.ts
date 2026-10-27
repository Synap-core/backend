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
import type { UnitTone } from "../units/state.js";
import {
  ASK_CHANGED_PREFIX,
  askAnswersInline,
  askOptionKey,
  askRefusalIsStale,
  questionDisposition,
  resolveAskResolution,
  type Ask,
  type QuestionDisposition,
  type QuestionDispositionInput,
  type AskOption,
  type AskProvideKind,
  type AskSnapshot,
  type ProvideConnectUnavailableReason,
  ASK_CONFIRM_KEYS,
  effectiveSlotAsk,
  type AskCause,
  type AskCauseKind,
  type AskAnswerValue,
} from "./index.js";
import type { RoomPostMeta } from "./room-post.js";
import {
  FATE_COPY,
  FATE_TONE,
  REVIEW_LATER_AFTER_MS,
} from "../proposals/fate.js";
import { ageSpan, ageSpanSpoken, shortDate } from "../lens/age.js";
import { CRITERION_SLOT_KIND } from "../focus-sessions/criterion-slot.js";

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
   * The PROPOSED row for an undecided agent draft (`draft-asks` signal): the
   * draft itself, to accept or reject. Composed ONCE, server-side, into the
   * signal's `title`; `agent` is null when the pod cannot name who started it.
   * It names no ask count: since the founder decision of 2026-10-22 a draft's
   * asks are Needs-you rows of their own, and counting them here too would
   * show one number in two places.
   */
  draftStarted: (agent: string | null, work: string): string =>
    `${agent?.trim() || "An agent"} started ${work}`,
  /**
   * The answer marks ({@link answerProvenanceMark}). `agent` is the relaying
   * agent's display name; null when the pod cannot name it.
   */
  answeredByYou: "You answered",
  // Unnamed, the relay is said without inventing "an agent" (founder,
  // 2026-10-26): the mark still says it was relayed, never who.
  relayedBy: (agent: string | null): string =>
    agent?.trim()
      ? `Answered in chat · relayed by ${agent.trim()}`
      : "Answered in chat · relayed",
  /** A relay the person then confirmed with their own tap. */
  relayConfirmed: (agent: string | null): string =>
    agent?.trim()
      ? `You confirmed what ${agent.trim()} relayed`
      : "You confirmed the relayed answer",
  /**
   * A commitment's relay, waiting for the person's tap: a MARK, not an
   * instruction. The Confirm / "Not what I said" pair beside it carries the
   * instruction, and a lock screen with no pair never says "Confirm it".
   */
  awaitingYourTap: (agent: string | null): string =>
    agent?.trim()
      ? `Relayed by ${agent.trim()} · needs your tap`
      : "Relayed · needs your tap",
  confirmRelayed: "Confirm",
  notWhatISaid: "Not what I said",
  /**
   * The person's own words under the answer a relay will record
   * ({@link relayRecordedAnswer}): the answer is the headline, this the quote.
   */
  youSaid: (quote: string): string => `You said “${quote.trim()}”`,
  /** The receipt after Confirm: what was settled, by the card's heading. */
  relayConfirmedReceipt: (heading: string): string =>
    `Confirmed · ${heading.trim()}`,
  /** The receipt after "Not what I said": nothing recorded, the ask reopens. */
  relayRejectedReceipt: "Not recorded · the question is yours again",
  /** `note` is the agent's one-line reason, when it gave one. */
  withdrawn: (note: string | null | undefined): string =>
    note?.trim() ? `Withdrawn · ${note.trim()}` : "Withdrawn",
  closedSessionEnded: "Closed · the session ended",
  /**
   * A relayed answer's words on its receipt (a relay waiting for the tap, or
   * one recorded): the person's own QUOTE when the agent carried it, else the
   * recorded answer. Null when there are no words to show.
   */
  relayedWords: (answer: {
    quote?: string | null;
    text?: string | null;
  }): string | null => {
    const words = answer.quote?.trim() || answer.text?.trim();
    return words ? `“${words}”` : null;
  },
  // ── The card's anatomy ({@link askCardView}) ──
  /** The card's age: "Asked 8d ago", or spoken, "Asked 8 days ago". */
  askedAgo: (span: string): string => `Asked ${span} ago`,
  /** The collapsed note affordance: one label, no placeholder repeating it. */
  addNote: "Add a note",
  /** The note field once opened: a noun, not the verb that opened it. */
  note: "Note",
  /** The mark on the answer the agent recommends. */
  recommended: "Recommended",
  /**
   * What raised an ask no agent asked ({@link AskCause}), as the door's words.
   * `at` is already formatted ("29 Sep"); absent, the date is left out.
   */
  askCause: (kind: AskCauseKind, at: string | null): string => {
    // A kind a newer pod sends: the ask still lives in a session.
    const head = ASK_CAUSE_WORDS[kind] ?? "From the session";
    return at ? `${head} · ${at}` : head;
  },
} as const;

/** The words of each {@link AskCauseKind}. Product copy, not vocabulary. */
const ASK_CAUSE_WORDS: Record<AskCauseKind, string> = {
  // Only a decision an AGENT wrote asks (founder, 2026-10-26), so never "your
  // note". Its title is already the card's heading: the door names the kind.
  decision: "From a proposed decision",
  gate: "From the session's gate",
  run: "From the run",
  external_approval: "From the external agent's run",
  param: "From the playbook's inputs",
  criterion: "From the session's checks",
};

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
 *   `none`     — nothing to judge: no recommendation, or a pick nobody can
 *                read (a room reply in words). A confirm may carry one too
 *                (founder, 2026-10-26): its `yes` / `no` `recommended`.
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
  if (!snap || !snap.recommendedKey) return none;
  if (snap.mode !== "choose" && snap.mode !== "confirm") return none;
  if (snap.followedRecommendation === true)
    return { outcome: "followed", recommendedLabel: null };
  if (snap.followedRecommendation !== false) return none;
  if (snap.mode === "confirm") {
    // The receipt's own words (`summarizeAnswer`), so "AI picked: Yes"
    // matches what the button and the receipt said.
    return {
      outcome: "overrode",
      recommendedLabel:
        snap.recommendedKey === ASK_CONFIRM_KEYS.yes
          ? ASK_COPY.yes
          : ASK_COPY.no,
    };
  }
  const rec = snap.options?.find(
    (o) => askOptionKey(o) === snap.recommendedKey
  );
  return { outcome: "overrode", recommendedLabel: rec?.label ?? null };
}

// ─── Where an answer came from ──────────────────────────────────────────────

/** The mark a question row or receipt draws: ONE tone + ONE label. */
export interface AnswerProvenanceMark {
  tone: UnitTone;
  label: string;
  /** The question's state the mark stands for — what a glyph keys on. */
  disposition: Exclude<QuestionDisposition, "open">;
}

/**
 * The mark for a question's state ({@link questionDisposition}), for every
 * surface (relay, browser, pod-admin). `null` while the question is open:
 * an open question draws its ask, not a mark.
 *
 * A relayed answer always SAYS it was relayed, even once confirmed: the
 * founder's trust rule for relays is that the mark is always visible.
 */
export function answerProvenanceMark(
  input: QuestionDispositionInput,
  opts: { agent?: string | null } = {}
): AnswerProvenanceMark | null {
  const agent = opts.agent ?? null;
  const disposition = questionDisposition(input);
  switch (disposition) {
    case "open":
      return null;
    case "answered":
      return input.answer?.confirmedAt && input.answer.relayedBy
        ? {
            tone: "success",
            label: ASK_COPY.relayConfirmed(agent),
            disposition,
          }
        : { tone: "success", label: ASK_COPY.answeredByYou, disposition };
    case "relayed":
      return { tone: "ai", label: ASK_COPY.relayedBy(agent), disposition };
    case "awaiting_your_tap":
      return {
        tone: "warning",
        label: ASK_COPY.awaitingYourTap(agent),
        disposition,
      };
    case "withdrawn":
      return {
        tone: "textMuted",
        label: ASK_COPY.withdrawn(input.closed?.note),
        disposition,
      };
    case "closed_session_ended":
      return {
        tone: "textMuted",
        label: ASK_COPY.closedSessionEnded,
        disposition,
      };
  }
}

// ─── The card: one anatomy, one derivation ──────────────────────────────────

/**
 * An owed ask's FATE ON SILENCE (founder, 2026-10-26) — the sibling of
 * `proposalFate` (`../proposals/fate.ts`), on the same clock:
 *   `review_later`      — owed for more than `REVIEW_LATER_AFTER_DAYS`: out
 *                         of the headline count, kept in Review later. Never
 *                         expires.
 *   `ends_with_session` — a confirm / choose: the agent's own question,
 *                         retired `session_ended` when its session ends
 *                         (`completeFocusSession`).
 *   `until_decided`     — everything else (act / form / provide / free text):
 *                         the person's deliverable, owed until done.
 * An unreadable `owedSince` fails toward KEEPING, like `proposalFate`.
 */
export type AskFate =
  | { kind: "review_later"; since: string }
  | { kind: "ends_with_session" }
  | { kind: "until_decided" };

/** The ask modes that end with their session (the `session_ended` rule). */
export const ASK_MODES_ENDING_WITH_SESSION = ["confirm", "choose"] as const;

/** The slot fields the fate and the card read — structural, off `ExpectedOutput`. */
export interface AskCardSlot {
  label: string;
  kind?: string | null;
  owner?: string | null;
  blockedReason?: string | null;
  why?: string | null;
  ask?: Ask | null;
  owedSince?: string | null;
  askCause?: AskCause | null;
  criterionKey?: string | null;
  paramName?: string | null;
  /** A relayed answer waiting for the person's tap — its own clock. */
  pendingRelay?: AskCardPendingRelay | null;
  /** The closing agent kept it owed past its session: it no longer ends with it. */
  keptOwedAt?: string | null;
  /** The asking agent's user id (`ExpectedOutput.askedBy`). */
  askedBy?: string | null;
  /**
   * Its display name, resolved by the pod (`askedByName`). `askCardView`
   * names the asker from it when the caller passes no `askerName`.
   */
  askedByName?: string | null;
}

/**
 * A slot's `pendingRelay` as the card reads it: `PendingRelayedAnswer`,
 * every field optional, so a wire row that parsed only part of it still
 * draws what it has.
 */
export interface AskCardPendingRelay {
  text?: string | null;
  value?: AskAnswerValue | null;
  relayedBy?: string | null;
  quote?: string | null;
  relayedAt?: string | null;
}

/**
 * Does this slot's ask end with its session? Read through `effectiveSlotAsk`.
 * A CRITERION grade never does, though its ask is a `choose`: it is the
 * person's verdict on the agent's work, graded on the session's scorecard
 * after the session as before it — not the agent's need to go on. Nor does
 * an ask the closing agent kept owed past the session (`keptOwedAt`).
 */
export function askEndsWithSession(slot: AskCardSlot): boolean {
  if (slot.kind === CRITERION_SLOT_KIND || slot.criterionKey) return false;
  if (slot.keptOwedAt) return false;
  const mode = (effectiveSlotAsk(slot) as Ask | null)?.mode;
  return (ASK_MODES_ENDING_WITH_SESSION as readonly string[]).includes(
    mode ?? ""
  );
}

/**
 * Since when the ask has waited on the person: the later of when it was owed
 * and when a relay last asked for their tap — a commitment relayed today is
 * fresh news, whatever the slot's age. Pure; `NaN` when neither is stamped.
 */
function askWaitingSince(
  slot: Pick<AskCardSlot, "owedSince" | "pendingRelay">
): number {
  const owed = slot.owedSince ? Date.parse(slot.owedSince) : NaN;
  const relayed = slot.pendingRelay?.relayedAt
    ? Date.parse(slot.pendingRelay.relayedAt)
    : NaN;
  if (Number.isFinite(owed) && Number.isFinite(relayed)) {
    return Math.max(owed, relayed);
  }
  return Number.isFinite(relayed) ? relayed : owed;
}

export function askFate(
  slot: AskCardSlot,
  now: Date | number = Date.now()
): AskFate {
  const owed = askWaitingSince(slot);
  const at = now instanceof Date ? now.getTime() : now;
  if (Number.isFinite(owed) && at > owed + REVIEW_LATER_AFTER_MS) {
    return {
      kind: "review_later",
      since: new Date(owed + REVIEW_LATER_AFTER_MS).toISOString(),
    };
  }
  return askEndsWithSession(slot)
    ? { kind: "ends_with_session" }
    : { kind: "until_decided" };
}

/**
 * Is this owed ask in Review later? The ONE predicate the needs-you count
 * and its list fold read (api `needs-you-union.ts`), so they cannot disagree.
 */
export function isAskReviewLater(
  slot: Pick<AskCardSlot, "owedSince" | "pendingRelay">,
  now: Date | number = Date.now()
): boolean {
  return askFate({ label: "", ...slot }, now).kind === "review_later";
}

/**
 * What raised the ask when no agent did: the stamped cause, else the one the
 * slot's own server stamps prove (a criterion slot, a param slot). `null`
 * when nothing can be named — never a guessed cause.
 */
export function effectiveAskCause(slot: AskCardSlot): AskCause | null {
  if (slot.askCause) return slot.askCause;
  if (slot.criterionKey) return { kind: "criterion" };
  if (slot.paramName) return { kind: "param" };
  return null;
}

/** The machine verbs producers prefixed onto labels and prompts. */
const ASK_VERB_PREFIX = /^\s*(?:decide|answer|accept)\s*:\s*/i;

/** The text with any machine verb prefix ("Decide:", "Answer:", "Accept:") stripped. */
export function stripAskVerbPrefix(text: string): string {
  return text.replace(ASK_VERB_PREFIX, "").trim();
}

/** Case, punctuation, whitespace and verb prefix folded away — for dedupe only. */
function askCore(text: string | null | undefined): string {
  return stripAskVerbPrefix(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does `text` say nothing `than` does not already say? Equal, or starting
 * with it, once case, punctuation, whitespace and verb prefix are folded.
 */
export function askTextRestates(text: string, than: string): boolean {
  const t = askCore(text);
  const h = askCore(than);
  return !!h && (t === h || t.startsWith(`${h} `));
}

/**
 * `text` minus the `than` it opens with, folded exactly as
 * {@link askTextRestates} folds (so "Pricing model: three tiers" loses
 * "pricing model"); "" when that is all it says; `text` itself when it does
 * not open with `than`.
 */
export function stripLeadingRestatement(text: string, than: string): string {
  if (!askTextRestates(text, than)) return text.trim();
  const body = stripAskVerbPrefix(text);
  const lead = askCore(than).split(" ").length;
  const words = [...body.matchAll(/[\p{L}\p{N}]+/gu)];
  const last = words[lead - 1];
  if (!last || last.index === undefined) return "";
  return body
    .slice(last.index + last[0].length)
    .replace(/^[\s.:;,—–-]+/, "")
    .trim();
}

/** One answer button: icon + tone + optional recommended mark + consequence. */
export interface AskCardAnswer {
  /** `yes` / `no` for a confirm, `askOptionKey` for a choose option. */
  key: string;
  label: string;
  /** One-line consequence of this answer, when the agent gave one. */
  description: string | null;
  recommended: boolean;
  /** `positive` = the affirmative answer, `neutral` = every other one. */
  tone: "positive" | "neutral";
  /** `check` / `x` for a confirm; a choose option's own icon, else null. */
  icon: string | null;
}

/**
 *   `agent` — a named agent asked; `sessionId` is the door (its session).
 *   `cause` — no agent asked: what did, as words + the cause's door.
 */
export type AskCardAsker =
  | { kind: "agent"; name: string; sessionId: string | null }
  | { kind: "cause"; cause: AskCause; label: string };

export interface AskCardView {
  /** The question, one line: a confirm's prompt, else the label, prefix stripped. */
  heading: string;
  /** The `why`, ONLY when it adds to the heading. Shown in full, never hover-only. */
  context: string | null;
  /** Who asked, as a named mark; `null` when nobody can be named. */
  asker: AskCardAsker | null;
  /**
   * Age + fate as ONE mark ("Asked 8d ago · Stays until you decide");
   * `spoken` is the same in full words, for a screen reader.
   */
  ageFate: { label: string; spoken: string; tone: UnitTone; fate: AskFate };
  /** The answer buttons (confirm, choose); empty for every other mode. */
  answers: AskCardAnswer[];
  /** The collapsed note affordance. */
  note: { label: string };
}

export interface AskCardViewOptions {
  /** The asker's display name, resolved by the pod (`askedByName`). */
  askerName?: string | null;
  /** The session the ask lives in — the asker mark's door. */
  sessionId?: string | null;
  now?: Date | number;
}

/**
 * THE ask card, derived ONCE for every surface (pod-admin, browser, relay,
 * push): heading, context, asker, age + fate, answers, note. A surface
 * arranges these; it never reads `slot.label` / `why` / `ask.prompt` for
 * display itself (pod-admin tripwire `ask-card-one-derivation`).
 *
 * The founder's complaint this answers (2026-10-26): the same question three
 * times, a fixed "It is waiting on your answer", an invented "An agent", and
 * Yes / No with no recommendation, icon or tone.
 */
export function askCardView(
  slot: AskCardSlot,
  opts: AskCardViewOptions = {}
): AskCardView {
  const ask = (effectiveSlotAsk(slot) as Ask | null) ?? null;
  const label = stripAskVerbPrefix(slot.label) || slot.label.trim();
  const prompt = ask?.mode === "confirm" ? ask.prompt?.trim() || "" : "";
  const heading = (prompt && stripAskVerbPrefix(prompt)) || label;

  const why = slot.why?.trim() || "";
  const context =
    why &&
    !askTextRestates(why, heading) &&
    !(prompt && askTextRestates(why, prompt))
      ? why
      : null;

  const name = opts.askerName?.trim() || slot.askedByName?.trim();
  const cause = name ? null : effectiveAskCause(slot);
  const asker: AskCardAsker | null = name
    ? { kind: "agent", name, sessionId: opts.sessionId ?? null }
    : cause
      ? {
          kind: "cause",
          cause,
          label: ASK_COPY.askCause(cause.kind, shortDate(cause.at)),
        }
      : null;

  const now = opts.now ?? Date.now();
  const nowMs = now instanceof Date ? now.getTime() : now;
  const fate = askFate(slot, now);
  // A proposal's fate words and tone (`FATE_COPY`, `FATE_TONE`): an ask
  // ending with its session is a session-bound draft's fate, said alike.
  const fateWords =
    fate.kind === "review_later"
      ? FATE_COPY.reviewLater
      : fate.kind === "ends_with_session"
        ? FATE_COPY.endsWithSession
        : FATE_COPY.untilDecided;
  const owed = slot.owedSince ? Date.parse(slot.owedSince) : NaN;
  const asked = Number.isFinite(owed);
  const ageFate = {
    label: asked
      ? `${ASK_COPY.askedAgo(ageSpan(nowMs - owed))} · ${fateWords}`
      : fateWords,
    spoken: asked
      ? `${ASK_COPY.askedAgo(ageSpanSpoken(nowMs - owed))} · ${fateWords}`
      : fateWords,
    tone: FATE_TONE[
      fate.kind === "ends_with_session" ? "dies_with_session" : fate.kind
    ],
    fate,
  };

  return {
    heading,
    context,
    asker,
    ageFate,
    answers: askCardAnswers(ask),
    note: { label: ASK_COPY.addNote },
  };
}

function askCardAnswers(ask: Ask | null): AskCardAnswer[] {
  if (ask?.mode === "confirm") {
    return [
      {
        key: ASK_CONFIRM_KEYS.yes,
        label: ask.yes?.label?.trim() || ASK_COPY.yes,
        description: ask.yes?.description?.trim() || null,
        recommended: ask.yes?.recommended === true,
        tone: "positive",
        icon: "check",
      },
      {
        key: ASK_CONFIRM_KEYS.no,
        label: ask.no?.label?.trim() || ASK_COPY.no,
        description: ask.no?.description?.trim() || null,
        recommended: ask.no?.recommended === true,
        tone: "neutral",
        icon: "x",
      },
    ];
  }
  if (ask?.mode === "choose") {
    return ask.options.map((o) => ({
      key: askOptionKey(o),
      label: o.label,
      description: o.description?.trim() || null,
      recommended: o.recommended === true,
      tone: "neutral" as const,
      icon: o.icon ?? null,
    }));
  }
  return [];
}

// ─── One row → the card's slot ──────────────────────────────────────────────

/** The needs-you union's discriminator for an owed slot (`Signal.kind`). */
const OWED_SLOT_SIGNAL_KIND = "owed-slot";

/**
 * Any owed-slot-shaped row, by the names each one carries its fields under:
 * the stored slot (`ExpectedOutput`: `label`, `kind`, `owedSince`), the
 * needs-you signal (`kind: 'owed-slot'`, `title`, `slotKind`, `occurredAt`,
 * `by`), and the surfaces' projections of either (`expectedLabel`).
 */
export interface AskCardSlotSource {
  expectedLabel?: string | null;
  label?: string | null;
  title?: string | null;
  /** The slot's kind, or the signal's discriminator (`owed-slot`). */
  kind?: string | null;
  /** The slot's kind on a needs-you signal. */
  slotKind?: string | null;
  owner?: string | null;
  blockedReason?: string | null;
  why?: string | null;
  ask?: Ask | null;
  owedSince?: string | null;
  /** A needs-you signal's `occurredAt`: its slot's `owedSince`. */
  occurredAt?: string | Date | null;
  askCause?: AskCause | null;
  criterionKey?: string | null;
  paramName?: string | null;
  pendingRelay?: AskCardPendingRelay | null;
  keptOwedAt?: string | null;
  askedBy?: string | null;
  askedByName?: string | null;
  /** A needs-you signal's named asker (`Signal.by`). */
  by?: { id?: string | null; label?: string | null } | null;
}

/**
 * THE adapter from any owed-slot row to {@link askCardView}'s slot. Every
 * field the card or its fate reads is carried, so no surface drops one by
 * hand-picking: a kept-owed confirm that read "Ends with the session", a slot
 * relayed today that read "In Review later", a param slot whose cause nobody
 * named were each a field one surface left out.
 *
 * On a needs-you signal (`kind: 'owed-slot'`) the slot's kind is `slotKind`,
 * its `owedSince` is the signal's `occurredAt`, and its asker is `by`.
 */
export function askCardSlotOf(row: AskCardSlotSource): AskCardSlot {
  const signal = row.kind === OWED_SLOT_SIGNAL_KIND;
  const occurred = signal ? row.occurredAt : null;
  const owedSince =
    row.owedSince ??
    (occurred instanceof Date ? occurred.toISOString() : (occurred ?? null));
  return {
    label: row.expectedLabel || row.label || row.title || "",
    kind: row.slotKind ?? (signal ? null : (row.kind ?? null)),
    owner: row.owner ?? null,
    blockedReason: row.blockedReason ?? null,
    why: row.why ?? null,
    ask: row.ask ?? null,
    owedSince,
    askCause: row.askCause ?? null,
    criterionKey: row.criterionKey ?? null,
    paramName: row.paramName ?? null,
    pendingRelay: row.pendingRelay ?? null,
    keptOwedAt: row.keptOwedAt ?? null,
    askedBy: row.askedBy ?? (signal ? (row.by?.id ?? null) : null),
    askedByName: row.askedByName ?? (signal ? (row.by?.label ?? null) : null),
  };
}

// ─── A relay waiting for the person's tap ───────────────────────────────────

/** The slot fields {@link slotAwaitsTap} reads — structural. */
export interface AskTapSlot {
  owner?: string | null;
  status?: string | null;
  /** A projection's boolean for `status: 'done'`. */
  done?: boolean | null;
  retiredAt?: string | null;
  attestedAt?: string | null;
  pendingRelay?: AskCardPendingRelay | null;
}

/**
 * Does this slot wait for the person's tap on a relayed answer? The ONE
 * predicate for every surface: a pending relay on a slot that is still owed
 * ({@link askSlotStanding}). Owed, not "unanswered": a slot the agent re-asked
 * still carries its old answer, and the relay is for the new ask.
 *
 * An absent `owner` reads as the person's: the rows that omit it (a needs-you
 * signal, the owed read) list only slots owed to them. A slot handed back
 * (`owner: 'agent'`), done, attested or retired never waits for a tap.
 */
export function slotAwaitsTap(slot: AskTapSlot | null | undefined): boolean {
  if (!slot?.pendingRelay) return false;
  return (
    askSlotStanding({
      owner: slot.owner === "agent" ? "agent" : "human",
      status: slot.done ? "done" : (slot.status ?? null),
      retiredAt: slot.retiredAt ?? null,
      attestedAt: slot.attestedAt ?? null,
    }) === "owed"
  );
}

/** What Confirm records for a relay, drawn as the card's answer. */
export interface RelayRecordedAnswer {
  /** The answer as its button reads ("Yes", the option's label), else the recorded text. */
  label: string;
  /** The card's answer it is, when the ask offers it (its icon and tone). */
  answer: AskCardAnswer | null;
  /** The person's own words, verbatim (`ASK_COPY.youSaid`); null when none. */
  quote: string | null;
}

/**
 * The answer a relay's Confirm will record, to headline with the person's
 * quote under it. Read off `pendingRelay.value` against the card's own
 * answers (`askCardView(...).answers`), so a confirm reads its button's label
 * ("Ship it", not the stored "Yes"). Pass the slot's EFFECTIVE ask
 * (`effectiveSlotAsk`). Without a typed value it is the recorded text. `null`
 * when there is no relay, or nothing readable to say.
 */
export function relayRecordedAnswer(
  ask: Ask | null | undefined,
  pendingRelay: AskCardPendingRelay | null | undefined
): RelayRecordedAnswer | null {
  if (!pendingRelay) return null;
  const value = pendingRelay.value ?? null;
  const key =
    value?.type === "confirm"
      ? value.confirmed
        ? ASK_CONFIRM_KEYS.yes
        : ASK_CONFIRM_KEYS.no
      : value?.type === "chip"
        ? askOptionKey(value.chip)
        : null;
  const answer =
    key === null
      ? null
      : (askCardAnswers(ask ?? null).find((a) => a.key === key) ?? null);
  const label =
    answer?.label ||
    (value?.type === "confirm"
      ? value.confirmed
        ? ASK_COPY.yes
        : ASK_COPY.no
      : value?.type === "chip"
        ? value.chip.label.trim()
        : "") ||
    pendingRelay.text?.trim() ||
    "";
  if (!label) return null;
  return { label, answer, quote: pendingRelay.quote?.trim() || null };
}

// ─── A room question's Confirm ──────────────────────────────────────────────

/**
 * Which door a room question's Confirm uses, or `null` when it waits for no
 * tap. The rule every room draws (relay chat, browser room, pod-admin):
 *   `slot`     — a relayed answer waits on the question's slot: Confirm and
 *                "Not what I said" settle it through the slot answer door,
 *                by `expectedLabel` (`confirmRelayed` / `rejectRelayed`).
 *   `approval` — an open approval card (`confirmationId`): its Confirm is the
 *                card itself, a DOOR to it, never a Confirm pair drawn here.
 * Only a slot-backed question can hold a relay that waits (the relay door
 * records a slotless question's answer as routine), so a slotless question
 * that is not an approval card never draws a Confirm. An answered or closed
 * question waits for nothing.
 */
export type RoomQuestionConfirmDoor =
  | { kind: "slot"; expectedLabel: string }
  | { kind: "approval"; confirmationId: string };

export function roomQuestionConfirmDoor(
  meta: RoomPostMeta | null | undefined
): RoomQuestionConfirmDoor | null {
  if (meta?.kind !== "question") return null;
  const disposition = questionDisposition(meta);
  const slotLabel =
    typeof meta.slotLabel === "string" ? meta.slotLabel.trim() : "";
  if (disposition === "awaiting_your_tap") {
    return slotLabel ? { kind: "slot", expectedLabel: slotLabel } : null;
  }
  const confirmationId =
    typeof meta.confirmationId === "string" ? meta.confirmationId.trim() : "";
  if (disposition === "open" && confirmationId) {
    return { kind: "approval", confirmationId };
  }
  return null;
}
