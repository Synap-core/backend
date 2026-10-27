/**
 * An answered ask → a `decision` entity's fields. PURE — the mapping the
 * answer door files (W2 of the decision mesh) and the one place it is decided.
 *
 * WHICH ASKS FILE A DECISION: `confirm` and `choose` only — a pick among
 * offered alternatives (or a yes/no) is a decision. A form, an act, a provide
 * and a legacy free-text slot are input, not a choice, and file nothing.
 *
 * WHAT IS KEPT: the full option set, the AI's recommendation, the person's
 * pick and whether it followed the recommendation — the structured half of the
 * mesh (`decisionOptions`, `chosenOption`, `recommendedOption`,
 * `followedRecommendation`), beside the prose half the profile always had
 * (`summary`, `rationale`, `alternatives`).
 */

import type {
  ExpectedOutput,
  SlotAnswer,
  SlotAskOption,
} from "@synap/playbooks";
import {
  ASK_CONFIRM_KEYS,
  askOptionKey,
  buildAskSnapshot,
  type AskSnapshot,
} from "@synap-core/types/ask";

/** The ask modes whose answer IS a decision. */
export const DECISION_ASK_MODES = ["confirm", "choose"] as const;

export function askFilesDecision(
  ask: { mode: string } | null | undefined
): boolean {
  return !!ask && (DECISION_ASK_MODES as readonly string[]).includes(ask.mode);
}

/** The `decisionStatus` vocabulary of the seeded `decision` profile. */
export type DecisionStatus =
  "proposed" | "accepted" | "superseded" | "rejected";

export interface DecisionDraft {
  title: string;
  properties: Record<string, unknown>;
}

const TITLE_MAX = 200;
const SUMMARY_MAX = 500;
const RICH_MAX = 5000;

/** The two options a confirm offers, as stored in `decisionOptions`. */
export const CONFIRM_OPTIONS: SlotAskOption[] = [
  { label: "Yes", value: ASK_CONFIRM_KEYS.yes },
  { label: "No", value: ASK_CONFIRM_KEYS.no },
];

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The person's own words beyond the pick. The answer's `text` is
 * `summarizeAnswer`'s "<pick> — <note>"; a free-text answer IS the note.
 */
function noteOf(answer: SlotAnswer): string {
  const v = answer.value;
  if (!v || v.type === "text") return "";
  const head =
    v.type === "chip"
      ? v.chip.label
      : v.type === "confirm"
        ? v.confirmed
          ? "Yes"
          : "No"
        : "";
  const prefix = `${head} — `;
  return head && answer.text.startsWith(prefix)
    ? answer.text.slice(prefix.length).trim()
    : "";
}

/** The label of what was chosen, as a person reads it. */
function chosenLabel(snapshot: AskSnapshot, answer: SlotAnswer): string {
  const v = answer.value;
  if (v?.type === "chip") {
    return v.chip.description
      ? `${v.chip.label} — ${v.chip.description}`
      : v.chip.label;
  }
  if (v?.type === "confirm") return v.confirmed ? "Yes" : "No";
  // Free text ("Other…") or a room reply in words: the words are the choice.
  return answer.text || (snapshot.chosenKey ?? "");
}

export interface DecisionFromAnswerInput {
  /** The slot AS IT WAS when answered (carries `ask`, `why`, `label`). */
  slot: Pick<ExpectedOutput, "label" | "ask" | "why" | "decisionId">;
  /** This answer — or, to read what a previous answer filed, that one. */
  answer: SlotAnswer;
  sessionId: string;
  /** The agent that asked, when it can be named. */
  askedByAgent?: string | null;
}

/**
 * The decision's fields, or `null` when this answer files no decision.
 *
 * `decisionStatus`: `accepted`, EXCEPT a confirm answered "No" on a slot that
 * was opened FOR an existing decision (`decisionId`) — that is the person
 * rejecting the proposed decision. A "No" to an ordinary confirm is still a
 * decision taken ("we will not X"), so it stays `accepted`.
 */
export function decisionFromAnswer(
  input: DecisionFromAnswerInput
): DecisionDraft | null {
  const { slot, answer } = input;
  if (!slot.ask || !askFilesDecision(slot.ask)) return null;
  const snapshot =
    answer.askSnapshot ?? buildAskSnapshot(slot.ask, answer.value, slot.why);

  const title = clip(
    (
      snapshot.prompt ||
      snapshot.why ||
      answer.question ||
      slot.label ||
      "Decision"
    ).trim(),
    TITLE_MAX
  );

  const options: SlotAskOption[] =
    snapshot.mode === "choose" ? (snapshot.options ?? []) : CONFIRM_OPTIONS;
  const others = options.filter((o) => askOptionKey(o) !== snapshot.chosenKey);
  const alternatives = others
    .map(
      (o) =>
        `- ${o.label}${o.description ? ` — ${o.description}` : ""}${o.recommended ? " (recommended)" : ""}`
    )
    .join("\n");

  const note = noteOf(answer);
  const rationale = [note, snapshot.why ? `Asked because: ${snapshot.why}` : ""]
    .filter(Boolean)
    .join("\n\n");

  const rejected =
    !!slot.decisionId &&
    answer.value?.type === "confirm" &&
    answer.value.confirmed === false;
  const status: DecisionStatus = rejected ? "rejected" : "accepted";

  const properties: Record<string, unknown> = {
    summary: clip(chosenLabel(snapshot, answer), SUMMARY_MAX),
    decisionStatus: status,
    decidedAt: answer.answeredAt,
    decisionOptions: options.map((o) => ({ ...o })),
    sourceSessionId: input.sessionId,
    ...(rationale ? { rationale: clip(rationale, RICH_MAX) } : {}),
    ...(alternatives ? { alternatives: clip(alternatives, RICH_MAX) } : {}),
    ...(snapshot.chosenKey !== null
      ? { chosenOption: snapshot.chosenKey }
      : {}),
    ...(snapshot.recommendedKey !== null
      ? { recommendedOption: snapshot.recommendedKey }
      : {}),
    // Absent, never false, when there was nothing to follow.
    ...(snapshot.followedRecommendation !== null
      ? { followedRecommendation: snapshot.followedRecommendation }
      : {}),
    ...(input.askedByAgent ? { askedByAgent: input.askedByAgent } : {}),
    ...relayFields(answer),
  };
  return { title, properties };
}

/**
 * The fields an answer DECIDES on a decision that already exists. Everything
 * else on it — summary, options, rationale, alternatives — is somebody's
 * record of the decision, and answering it must never rewrite it.
 */
const DECIDED_FIELDS = [
  "decisionStatus",
  "decidedAt",
  "chosenOption",
  "recommendedOption",
  "followedRecommendation",
  "sourceSessionId",
  "askedByAgent",
  "answeredVia",
  "relayedBy",
  "relayQuote",
] as const;

/** The prose fields whose value depends on the pick. */
const PICK_PROSE_FIELDS = ["summary", "alternatives"] as const;

/**
 * What an answer writes on the EXISTING decision its slot points at
 * (`slot.decisionId`). Pure.
 *
 * The decided fields only. A pick-dependent prose field is revised only when
 * it still holds exactly what the slot's PREVIOUS answer wrote (a re-answer to
 * a decision an answer filed): the door rewrites its own words, never a
 * person's or an agent's. The person's note is appended to the rationale (the
 * profile has no field of its own for it), never replacing it.
 */
export function decisionUpdateFromAnswer(p: {
  /** `decisionFromAnswer` of this answer. */
  draft: DecisionDraft;
  /** `decisionFromAnswer` of the slot's previous answer, when there was one. */
  previous: DecisionDraft | null;
  /** The decision's properties as stored now. */
  existing: Record<string, unknown>;
  answer: SlotAnswer;
}): Record<string, unknown> {
  const { draft, previous, existing } = p;
  const update: Record<string, unknown> = {};
  for (const key of DECIDED_FIELDS) {
    if (draft.properties[key] !== undefined) update[key] = draft.properties[key];
  }
  for (const key of PICK_PROSE_FIELDS) {
    if (
      previous &&
      previous.properties[key] !== undefined &&
      existing[key] === previous.properties[key] &&
      draft.properties[key] !== undefined
    ) {
      update[key] = draft.properties[key];
    }
  }
  const note = noteOf(p.answer);
  if (note) {
    const before =
      typeof existing.rationale === "string" ? existing.rationale.trim() : "";
    update.rationale = clip(
      [before, `When deciding: ${note}`].filter(Boolean).join("\n\n"),
      RICH_MAX
    );
  }
  return update;
}

/** The relay's record on a decision ({@link relayFields}). */
export const RELAY_DECISION_FIELDS = [
  "answeredVia",
  "relayedBy",
  "relayQuote",
] as const;

/**
 * The relay fields an answer must REMOVE from the decision it updates: a tap
 * after a relay the person rejected writes none of its own, and `entities.update`
 * merges properties, so the rejected relay's provenance and words would stay
 * on a decision they no longer decided. Pure.
 */
export function staleRelayFields(
  existing: Record<string, unknown>,
  answer: SlotAnswer
): string[] {
  if (answer.relayedBy) return [];
  return RELAY_DECISION_FIELDS.filter((k) => existing[k] !== undefined);
}

/**
 * The person said "Not what I said" to the relayed answer that decided this
 * decision: it is undecided again — `proposed`, without the pick and without
 * the relay — until their own answer decides it. Pure.
 */
export function decisionReopenedFromRelay(): {
  properties: Record<string, unknown>;
  deleteProperties: string[];
} {
  return {
    properties: { decisionStatus: "proposed" },
    deleteProperties: [
      "decidedAt",
      "chosenOption",
      "followedRecommendation",
      ...RELAY_DECISION_FIELDS,
    ],
  };
}

/**
 * Where the answer came from, on the decision it filed (the relay door). Only
 * an answer an agent RELAYED carries any: `answeredVia` says whether the
 * person then tapped Confirm (`tap`) or the relay alone decided (`relayed`),
 * and `relayedBy` / `relayQuote` keep who carried which words, both ways — a
 * confirm never erases the relay from the record. A plain tap adds nothing.
 */
function relayFields(answer: SlotAnswer): Record<string, unknown> {
  if (!answer.relayedBy) return {};
  return {
    answeredVia: answer.via === "relayed" ? "relayed" : "tap",
    relayedBy: answer.relayedBy,
    ...(answer.quote ? { relayQuote: clip(answer.quote, RICH_MAX) } : {}),
  };
}
