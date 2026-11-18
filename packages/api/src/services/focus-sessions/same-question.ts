/**
 * ONE CARD PER QUESTION (plan efb315a5, W1): does a slot an agent is handing
 * the person ask what an OPEN question of the same session already asks?
 *
 * Live, session cf60123c (17 Nov 2026): a pod-run agent declared "Disposition
 * Esteban Arias — Nurturing ou Disqualified" in one turn and "Disposition
 * d'Esteban Arias (Prometheus)" in the next — the same decision, two cards,
 * answered "Disqualified" and "Nurturing". The labels differ, the option
 * VALUES and the `why` differ (each turn wrote its own), so neither the label
 * nor `askFingerprint` sees the twin. What the two share is the choice offered
 * (the option LABELS) and the subject named in the label.
 *
 * THE RULE ("never merge two questions that differ"):
 *   1. the same label (trimmed, case-folded) is the same question; or
 *   2. both asks are the same KIND of question —
 *        `choose` with the same set of option labels (at least two), or
 *        `confirm` with the same prompt —
 *      AND their labels name the same subject: once text in parentheses or
 *      brackets is dropped, their word SETS (letters and digits, accents
 *      folded, every token kept — a number or a short code names the
 *      subject — minus the option labels' own words and a short list of
 *      connecting words) are EQUAL, with at least MIN_SUBJECT_WORDS words;
 *   3. never when both slots point at different objects (`ref.id`).
 *
 * What it does NOT see, said: two questions with different options about the
 * same subject (they differ: both stand), the same question re-worded with
 * different subject words ("Disposition Arias" vs "What to do with Esteban":
 * both stand), and a `form` / `act` / `provide` ask (only rule 1 applies).
 * A label that names MORE than another ("Send the email" vs "Send the email
 * to Bob", same Yes/No prompt) is a different question: both stand. So is
 * one that names another number ("Approve invoice 12" vs "Approve invoice
 * 13"). A parenthesised aside is not the subject ("Disposition d'Esteban
 * Arias (Prometheus)" names Esteban Arias).
 *
 * Pure. "Open" is THE rule of the room model (`isOpenQuestion`,
 * `@synap-core/types/session-room`).
 */

import type { ExpectedOutput } from "@synap/playbooks";
import { isOpenQuestion, type RoomSlot } from "@synap-core/types/session-room";
import { normalizeExpectedLabel } from "./expected-label.js";

/** What a deduped hand-over says back: the card the person already has. */
export interface DedupedQuestion {
  /** The open slot's key (`null` for a legacy slot with none). */
  key: string | null;
  /** The open slot's label: the card the person answers. */
  label: string;
  /** The label the caller tried to hand over. */
  asked: string;
}

/** THE room rule, on a stored slot. */
export function isOpenQuestionSlot(slot: ExpectedOutput | undefined): boolean {
  return !!slot && isOpenQuestion(slot as unknown as RoomSlot);
}

/** A subject is named by at least this many words (one word names too little). */
export const MIN_SUBJECT_WORDS = 2;
/** A choice is the same choice only with at least this many options. */
export const MIN_CHOICE_OPTIONS = 2;

/**
 * Connecting words that name no subject (English, French). Every other token
 * is kept, whatever its length: "12", "Q3" or "EU" can be the whole
 * difference between two questions.
 */
const CONNECTORS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "about",
  "d",
  "l",
  "de",
  "du",
  "la",
  "le",
  "les",
  "des",
  "un",
  "une",
  "et",
  "ou",
  "en",
  "au",
  "aux",
  "pour",
  "avec",
  "sur",
  "dans",
]);

function words(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !CONNECTORS.has(w));
}

type AskLike = {
  mode?: unknown;
  prompt?: unknown;
  options?: unknown;
};

function askOf(slot: ExpectedOutput): AskLike | null {
  const ask = (slot as { ask?: unknown }).ask;
  return ask && typeof ask === "object" ? (ask as AskLike) : null;
}

function optionLabels(ask: AskLike): string[] {
  if (!Array.isArray(ask.options)) return [];
  return ask.options
    .map((o) =>
      o && typeof o === "object"
        ? normalizeExpectedLabel((o as { label?: unknown }).label as string)
        : ""
    )
    .filter((l): l is string => !!l);
}

/** The same kind of question: the same choice offered, or the same yes/no. */
function sameChoice(a: AskLike, b: AskLike): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "choose") {
    const la = new Set(optionLabels(a));
    const lb = new Set(optionLabels(b));
    if (la.size < MIN_CHOICE_OPTIONS || la.size !== lb.size) return false;
    for (const l of la) if (!lb.has(l)) return false;
    return true;
  }
  if (a.mode === "confirm") {
    const pa = normalizeExpectedLabel(a.prompt as string);
    return !!pa && pa === normalizeExpectedLabel(b.prompt as string);
  }
  return false;
}

/** The labels name the same subject (see the header's rule 2). */
function sameSubject(
  a: ExpectedOutput,
  b: ExpectedOutput,
  ask: AskLike
): boolean {
  const optionWords = new Set(optionLabels(ask).flatMap(words));
  const subject = (label: string) =>
    new Set(
      words(label.replace(/\([^)]*\)|\[[^\]]*\]/g, " ")).filter(
        (w) => !optionWords.has(w)
      )
    );
  const wa = subject(a.label);
  const wb = subject(b.label);
  if (wa.size < MIN_SUBJECT_WORDS || wa.size !== wb.size) return false;
  for (const w of wa) if (!wb.has(w)) return false;
  return true;
}

function refId(slot: ExpectedOutput): string | null {
  const ref = (slot as { ref?: unknown }).ref;
  if (!ref || typeof ref !== "object") return null;
  const id = (ref as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

/** Does `a` ask what `b` asks? Symmetric. Pure. */
export function sameQuestion(a: ExpectedOutput, b: ExpectedOutput): boolean {
  const ra = refId(a);
  const rb = refId(b);
  if (ra && rb && ra !== rb) return false;
  const la = normalizeExpectedLabel(a.label);
  if (la && la === normalizeExpectedLabel(b.label)) return true;
  const askA = askOf(a);
  const askB = askOf(b);
  if (!askA || !askB || !sameChoice(askA, askB)) return false;
  return sameSubject(a, b, askA);
}

/**
 * The OPEN question of `slots` that `candidate` (the slot as it would be
 * handed over) asks again, skipping `self` (the stored slot being handed
 * over, when there is one). `undefined` when there is none.
 */
export function openTwinQuestion(
  slots: readonly ExpectedOutput[],
  candidate: ExpectedOutput,
  self?: ExpectedOutput
): ExpectedOutput | undefined {
  return slots.find(
    (s) => s !== self && isOpenQuestionSlot(s) && sameQuestion(s, candidate)
  );
}

/** The sentence a deduped hand-over says back to the agent. */
export function dedupedQuestionWarning(d: DedupedQuestion): string {
  return (
    `"${d.asked}" asks what "${d.label}" already asks the person, and that ` +
    `card is still open: no second card was made. Their answer lands on ` +
    `"${d.label}"${d.key ? ` (key ${d.key})` : ""}; read it there.`
  );
}
