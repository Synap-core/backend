/**
 * The words of this folder's request story and request row, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type, French
 * translates it. DRAFT French, awaiting the founder's review with the
 * vocabulary's. What an agent or a person wrote (a slot's label, a proposal's
 * summary, a note) is a param, printed as written, never translated.
 */
import { ambientCatalogLocale } from "../i18n/ambient.js";
import { createT, type Catalog, type Locale } from "../i18n/index.js";

export const en = {
  // ── The story's past lines, one per timeline event kind ──────────────
  "needsYou.story.sessionStarted": "Session started",
  "needsYou.story.statusMoved": "Moved to {status}",
  "needsYou.story.prOpened": "Opened {repo}#{number}",
  "needsYou.story.prMerged": "Merged {repo}#{number}",
  "needsYou.story.prClosed": "Closed {repo}#{number} without merging",
  "needsYou.story.checks":
    "{result, select, passed {Checks passed} failed {Checks failed} other {Checks finished}}",
  "needsYou.story.decisionAsked":
    "{titled, select, yes {Proposed: {title}} other {Proposed a change}}",
  // `status` is the decision's word from the vocabulary door
  // (`resolveStatusLabel`), the one every surface says for it.
  "needsYou.story.decisionAnswered":
    "{titled, select, yes {{status}: {title}} other {{status}}}",
  "needsYou.story.slotAsked": "Asked you: {slot}",
  "needsYou.story.slotAnswered": "Answered: {slot}",
  // A refusal (`{ type: "declined" }`) is an answer on the wire, and a no.
  "needsYou.story.slotRefused": "Refused: {slot}",
  "needsYou.story.slotAttested": "Marked done: {slot}",
  "needsYou.story.slotHandedBack": "Not mine: {slot}",
  "needsYou.story.relayCorrected":
    "{named, select, yes {Relayed answer corrected: {slot}} other {Relayed answer corrected}}",
  "needsYou.story.questionWithdrawn":
    "{named, select, yes {Took back the question: {slot}} other {Took back a question}}",
  // A group of the same thing happening several times in a row.
  "needsYou.story.repeat": "{n, plural, one {# time} other {# times}}",
  // The past folded above the shown lines.
  "needsYou.story.moreEvents":
    "{n, plural, one {# more event} other {# more events}}",
  // ── Now ──────────────────────────────────────────────────────────────
  "needsYou.story.meanwhile": "Meanwhile",
  // ── After: what moves once the person decides ───────────────────────
  "needsYou.story.unblocks": "Unblocks",
  "needsYou.story.thingMoves": "{thing} can move on",
  "needsYou.story.sessionsWait":
    "{n, plural, one {# session waits on this} other {# sessions wait on this}}",
  // ── Parts a read could not answer ────────────────────────────────────
  "needsYou.story.unreadable.timeline":
    "What happened before could not be read.",
  "needsYou.story.unreadable.aiCanDo":
    "What the agent works on meanwhile could not be read.",
  "needsYou.story.unreadable.waiting":
    "Which sessions wait on this could not be read.",
  "needsYou.story.unreadable.proposalWaits":
    "Whether an agent waits on this could not be read.",
  "needsYou.story.unreadable.subject": "What this is about could not be read.",
  // ── The row's second line ────────────────────────────────────────────
  "needsYou.row.holds": "Holds",
} as const;

export const fr: Catalog<typeof en> = {
  "needsYou.story.sessionStarted": "Session démarrée",
  "needsYou.story.statusMoved": "Passé à {status}",
  "needsYou.story.prOpened": "{repo}#{number} ouverte",
  "needsYou.story.prMerged": "{repo}#{number} fusionnée",
  "needsYou.story.prClosed": "{repo}#{number} fermée sans fusion",
  "needsYou.story.checks":
    "{result, select, passed {Vérifications réussies} failed {Vérifications en échec} other {Vérifications terminées}}",
  "needsYou.story.decisionAsked":
    "{titled, select, yes {Proposé : {title}} other {A proposé un changement}}",
  "needsYou.story.decisionAnswered":
    "{titled, select, yes {{status} : {title}} other {{status}}}",
  "needsYou.story.slotAsked": "Vous a demandé : {slot}",
  "needsYou.story.slotAnswered": "Répondu : {slot}",
  "needsYou.story.slotRefused": "Refusé : {slot}",
  "needsYou.story.slotAttested": "Marqué comme fait : {slot}",
  "needsYou.story.slotHandedBack": "Pas pour moi : {slot}",
  "needsYou.story.relayCorrected":
    "{named, select, yes {Réponse relayée corrigée : {slot}} other {Réponse relayée corrigée}}",
  "needsYou.story.questionWithdrawn":
    "{named, select, yes {Question retirée : {slot}} other {Une question retirée}}",
  "needsYou.story.repeat": "{n, plural, one {# fois} other {# fois}}",
  "needsYou.story.moreEvents":
    "{n, plural, one {# autre événement} other {# autres événements}}",
  "needsYou.story.meanwhile": "Pendant ce temps",
  "needsYou.story.unblocks": "Débloque",
  "needsYou.story.thingMoves": "{thing} peut avancer",
  "needsYou.story.sessionsWait":
    "{n, plural, one {# session attend ceci} other {# sessions attendent ceci}}",
  "needsYou.story.unreadable.timeline":
    "Ce qui s’est passé avant n’a pas pu être lu.",
  "needsYou.story.unreadable.aiCanDo":
    "Ce que l’agent fait pendant ce temps n’a pas pu être lu.",
  "needsYou.story.unreadable.waiting":
    "Les sessions qui attendent ceci n’ont pas pu être lues.",
  "needsYou.story.unreadable.proposalWaits":
    "Si un agent attend ceci n’a pas pu être lu.",
  "needsYou.story.unreadable.subject":
    "L’objet de cette demande n’a pas pu être lu.",
  "needsYou.row.holds": "Bloque",
};

export const needsYouCopy = { en, fr } as const;

/** This folder's translator, in `locale` (else the ambient catalog locale). */
export function needsYouT(locale?: Locale) {
  return createT(locale ?? ambientCatalogLocale(), needsYouCopy);
}
