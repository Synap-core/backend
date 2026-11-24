/**
 * `/device`'s new words, as catalogs (`@synap-core/types/i18n`): English is
 * the source and the type. The page's older words still sit in its views and
 * move here as they change. DRAFT French ("vous"), awaiting the founder's
 * review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  /** Under the write-mode pick, for a NEW computer (plan 07ecf0be D1b). */
  "writeMode.newComputer":
    "{computer} starts with this too: no agent on it ever does more. You can change it on its page.",
  "run.before": "Run",
  "run.after": "again in your terminal for a new code.",
  "enter.title": "Enter the code from your terminal",
  "enter.code": "Code",
  "enter.continue": "Continue",
  "pending.check": "Check your terminal shows",
  "pending.already":
    "Already connected · {n, plural, one {# agent} other {# agents}}",
  "pending.name": "Name",
  "pending.approve": "Approve",
  "pending.notMe": "This wasn't me",
  "pending.details": "Details",
  "detail.access": "Access",
  "detail.keyLifetime": "Key lifetime",
  "detail.requestedFrom": "Requested from",
  "detail.client": "Client",
  "detail.requested": "Requested",
  "detail.expires": "Expires",
  "done.title": "Return to your terminal",
  "locked.title": "Too many wrong codes",
  "failed.read": "Couldn't read this request: {message}",
  "failed.retry": "Retry",
  loading: "Reading…",
} as const;

export const fr: Catalog<typeof en> = {
  "writeMode.newComputer":
    "{computer} démarre aussi avec ce réglage : aucun agent dessus ne fait jamais plus. Vous pouvez le changer sur sa page.",
  "run.before": "Exécutez",
  "run.after": "de nouveau dans votre terminal pour obtenir un nouveau code.",
  "enter.title": "Saisissez le code affiché dans votre terminal",
  "enter.code": "Code",
  "enter.continue": "Continuer",
  "pending.check": "Vérifiez que votre terminal affiche",
  "pending.already":
    "Déjà connecté · {n, plural, one {# agent} other {# agents}}",
  "pending.name": "Nom",
  "pending.approve": "Approuver",
  "pending.notMe": "Ce n’était pas moi",
  "pending.details": "Détails",
  "detail.access": "Accès",
  "detail.keyLifetime": "Durée de la clé",
  "detail.requestedFrom": "Demandé depuis",
  "detail.client": "Client",
  "detail.requested": "Demandé",
  "detail.expires": "Expire",
  "done.title": "Retournez à votre terminal",
  "locked.title": "Trop de codes erronés",
  "failed.read": "Impossible de lire cette demande : {message}",
  "failed.retry": "Réessayer",
  loading: "Lecture…",
};

/** The words' translator, in the ambient catalog locale. */
export function deviceT() {
  return createT(ambientCatalogLocale(), { en, fr });
}
