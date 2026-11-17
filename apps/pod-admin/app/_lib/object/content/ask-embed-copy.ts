/**
 * The words around a `:::synap-ask` card (`embed-ask`), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French ("vous"), awaiting the founder's review. The question itself, its
 * options and the answer controls are the shared answer card's own words
 * (`review/_lib/ask-answer`); this file only words what surrounds it.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "section.label": "Question waiting for your answer",
  "loading.aria": "Loading the question…",
  "failed.line": "This question couldn’t be loaded.",
  "failed.retry": "Try again",
  "failed.retrying": "Retrying…",
  "hidden.line": "This question isn’t available.",
  "broken.line": "This question can’t be shown: its reference is incomplete.",
  "closed.line": "This question was closed without an answer.",
  "elsewhere.line": "This one is answered on the {noun}’s own page.",
  "member.line": "Only the person who owns this {noun} can answer it.",
  "answered.mark": "Answered",
  "answered.attested": "Marked as done",
  "answered.sent": "Answer sent",
  "receipt.handedBack": "Handed back to the agent",
  "receipt.refused": "Refused",
  "from.named": "Question from {title}",
  "from.unnamed": "Question from this {noun}",
  "door.session": "Open the {noun}",
  "inline.mark": "Question",
} as const;

export const fr: Catalog<typeof en> = {
  "section.label": "Question en attente de votre réponse",
  "loading.aria": "Chargement de la question…",
  "failed.line": "Impossible de charger cette question.",
  "failed.retry": "Réessayer",
  "failed.retrying": "Nouvelle tentative…",
  "hidden.line": "Cette question n’est pas disponible.",
  "broken.line":
    "Cette question ne peut pas s’afficher : sa référence est incomplète.",
  "closed.line": "Cette question a été clôturée sans réponse.",
  "elsewhere.line": "On y répond depuis la page du {noun}.",
  "member.line":
    "Seule la personne à qui appartient ce {noun} peut y répondre.",
  "answered.mark": "Répondu",
  "answered.attested": "Marqué comme fait",
  "answered.sent": "Réponse envoyée",
  "receipt.handedBack": "Rendu à l’agent",
  "receipt.refused": "Refusé",
  "from.named": "Question de {title}",
  "from.unnamed": "Question de ce {noun}",
  "door.session": "Ouvrir le {noun}",
  "inline.mark": "Question",
};

/** The card's translator, in the ambient catalog locale. */
export function askEmbedT() {
  return createT(ambientCatalogLocale(), { en, fr });
}
