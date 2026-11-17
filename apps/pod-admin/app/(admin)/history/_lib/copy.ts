/**
 * Historique's words, as catalogs (`@synap-core/types/i18n`): English is the
 * source and the type. Client words (audit 110dd4ab G1): a request, never a
 * proposal. DRAFT French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";
import { NEEDS_YOU_RISK_LABELS } from "@synap-core/types/needs-you";

export const en = {
  title: "History",
  description:
    "What was decided on the requests, newest first. Undo what can still be undone.",
  empty: "Nothing decided yet. Approved and rejected requests show here.",
  failed: "Couldn’t load the history.",
  "row.askedBy": "Asked by {who}",
  "row.decidedBy": "Decided by {who}",
  "row.decidedByRule": "Approved by a standing rule",
  // The one words of the mark (`needsYouRisk`), never a third copy.
  "row.noUndo": NEEDS_YOU_RISK_LABELS.irreversible,
  showAll: "{n, plural, one {Show # decision} other {Show all # decisions}}",
  showOlder: "Show older decisions",
  olderFailed: "Couldn’t load older decisions.",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Historique",
  description:
    "Ce qui a été décidé sur les demandes, du plus récent au plus ancien. Annulez ce qui peut encore l’être.",
  empty:
    "Rien n’a encore été décidé. Les demandes approuvées ou rejetées s’affichent ici.",
  failed: "Impossible de charger l’historique.",
  "row.askedBy": "Demandé par {who}",
  "row.decidedBy": "Décidé par {who}",
  "row.decidedByRule": "Approuvé par une règle permanente",
  "row.noUndo": "Ne peut pas être annulé",
  showAll:
    "{n, plural, one {Afficher la décision} other {Afficher les # décisions}}",
  showOlder: "Afficher les décisions plus anciennes",
  olderFailed: "Impossible de charger les décisions plus anciennes.",
};
