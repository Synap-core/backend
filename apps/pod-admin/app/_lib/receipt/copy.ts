/**
 * The words of a decision's receipt, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. Client words: a request,
 * never a proposal. DRAFT French, awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "approve.applied": "Request approved",
  "approve.noEffect": "Approved, but nothing changed",
  "approve.partial": "Approved, but not all of it",
  "approve.partialHint":
    "{n, plural, one {# part wasn’t applied.} other {# parts weren’t applied.}}",
  "approve.already": "Already approved: nothing changed",
  "approve.failed": "Couldn’t approve this request",
  "reject.applied": "Request rejected",
  "reject.failed": "Couldn’t reject this request",
  "approve.undoHint":
    "Undo takes the change back and returns the request to you. Anything already sent stays sent.",
  "reject.undoHint": "Undo returns the request to you.",
  "failed.hint": "Nothing changed. Try again.",
  undo: "Undo",
  "undo.done": "Decision undone",
  "undo.doneHint": "The request is waiting for you again.",
  "undo.partly": "Partly undone",
  "undo.partlyHint":
    "Some of it changed since it was approved, so it was kept.",
  "undo.nothing": "Nothing was undone",
  "undo.nothingHint": "It changed since it was approved, so it was kept.",
  "undo.permanentHint": "What was already sent stays sent.",
  "undo.failed": "Couldn’t undo this decision",
  "batchReject.all":
    "{n, plural, one {Rejected # request} other {Rejected # requests}}",
  "batchReject.some":
    "Rejected {rejected} of {picked, plural, one {# request} other {# requests}}",
  "batchReject.none": "Nothing rejected",
  "batchReject.notRejectedHint":
    "{n, plural, one {# was already decided or withdrawn.} other {# were already decided or withdrawn.}}",
  "batchReject.failed": "Couldn’t reject these requests",
  "batchApprove.failed": "Couldn’t approve these requests",
  "batchApprove.all":
    "{n, plural, one {Approved # request} other {Approved # requests}}",
  "batchApprove.some":
    "Approved {approved} of {picked, plural, one {# request} other {# requests}}",
  "batchApprove.none": "Nothing approved",
  "batchApprove.failedHint":
    "{n, plural, one {# couldn’t be approved: the reason is listed on the page.} other {# couldn’t be approved: the reasons are listed on the page.}}",
} as const;

export const fr: Catalog<typeof en> = {
  "approve.applied": "Demande approuvée",
  "approve.noEffect": "Approuvée, mais rien n’a changé",
  "approve.partial": "Approuvée en partie",
  "approve.partialHint":
    "{n, plural, one {# élément n’a pas été appliqué.} other {# éléments n’ont pas été appliqués.}}",
  "approve.already": "Déjà approuvée : rien n’a changé",
  "approve.failed": "Impossible d’approuver cette demande",
  "reject.applied": "Demande rejetée",
  "reject.failed": "Impossible de rejeter cette demande",
  "approve.undoHint":
    "Annuler retire la modification et vous rend la demande. Ce qui a déjà été envoyé le reste.",
  "reject.undoHint": "Annuler vous rend la demande.",
  "failed.hint": "Rien n’a changé. Réessayez.",
  undo: "Annuler",
  "undo.done": "Décision annulée",
  "undo.doneHint": "La demande vous attend de nouveau.",
  "undo.partly": "Annulée en partie",
  "undo.partlyHint":
    "Une partie a changé depuis l’approbation, elle a donc été gardée.",
  "undo.nothing": "Rien n’a été annulé",
  "undo.nothingHint":
    "Elle a changé depuis l’approbation, elle a donc été gardée.",
  "undo.permanentHint": "Ce qui a déjà été envoyé le reste.",
  "undo.failed": "Impossible d’annuler cette décision",
  "batchReject.all":
    "{n, plural, one {# demande rejetée} other {# demandes rejetées}}",
  "batchReject.some":
    "{rejected, plural, one {# demande rejetée} other {# demandes rejetées}} sur {picked}",
  "batchReject.none": "Aucune demande rejetée",
  "batchReject.notRejectedHint":
    "{n, plural, one {# était déjà décidée ou retirée.} other {# étaient déjà décidées ou retirées.}}",
  "batchReject.failed": "Impossible de rejeter ces demandes",
  "batchApprove.failed": "Impossible d’approuver ces demandes",
  "batchApprove.all":
    "{n, plural, one {# demande approuvée} other {# demandes approuvées}}",
  "batchApprove.some":
    "{approved, plural, one {# demande approuvée} other {# demandes approuvées}} sur {picked}",
  "batchApprove.none": "Aucune demande approuvée",
  "batchApprove.failedHint":
    "{n, plural, one {# n’a pas pu être approuvée : la raison est indiquée sur la page.} other {# n’ont pas pu être approuvées : les raisons sont indiquées sur la page.}}",
};

/** The receipt's translator, in the ambient catalog locale. */
export function receiptT() {
  return createT(ambientCatalogLocale(), { en, fr });
}
