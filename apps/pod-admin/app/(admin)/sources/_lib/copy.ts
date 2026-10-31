/**
 * The pod-level source config drawer's words, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT French
 * ("vous"), awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "drawer.fallbackTitle": "Source",
  "scope.pod": "Pod-level",
  "scope.space": "Space {id}",
  "fact.status": "Status",
  "fact.provider": "Provider",
  "fact.scope": "Scope",
  "fact.lastTest": "Last test",
  "fact.created": "Created",
  "fact.id": "Source ID",
  "status.enabled": "Enabled",
  "status.disabled": "Disabled",
  "lastTest.never": "Never tested",
  "lastTest.ok": "Passed {when}",
  "lastTest.error": "Failed {when}",
  "lastTest.errorWhy": "Failed {when}: {why}",
  "test.button": "Test connection",
  "test.running": "Testing…",
  "test.title": "Connection",
  "test.hint":
    "Reads the source once, the way the pod does, and shows what it answered.",
  "test.ok": "The source answered.",
  "test.okSample":
    "The source answered with {n, plural, one {# item} other {# items}}.",
  "test.error": "The source did not answer: {why}",
  "test.errorNoReason": "The source did not answer, and gave no reason.",
  "test.couldNotRun": "Couldn’t run the test: {why}",
  "edit.title": "Source settings live in the app",
  "edit.body":
    "Changing where a source reads from, or its credentials, happens in the app. Pod Console shows the source and tests it; it does not edit it.",
  "edit.cta": "Open Connectors settings",
} as const;

export const fr: Catalog<typeof en> = {
  "drawer.fallbackTitle": "Source",
  "scope.pod": "Tout le serveur",
  "scope.space": "Espace {id}",
  "fact.status": "État",
  "fact.provider": "Fournisseur",
  "fact.scope": "Portée",
  "fact.lastTest": "Dernier test",
  "fact.created": "Créée",
  "fact.id": "Identifiant de la source",
  "status.enabled": "Activée",
  "status.disabled": "Désactivée",
  "lastTest.never": "Jamais testée",
  "lastTest.ok": "Réussi {when}",
  "lastTest.error": "Échec {when}",
  "lastTest.errorWhy": "Échec {when} : {why}",
  "test.button": "Tester la connexion",
  "test.running": "Test en cours…",
  "test.title": "Connexion",
  "test.hint":
    "Lit la source une fois, comme le fait le serveur, et montre ce qu’elle a répondu.",
  "test.ok": "La source a répondu.",
  "test.okSample":
    "La source a répondu avec {n, plural, one {# élément} other {# éléments}}.",
  "test.error": "La source n’a pas répondu : {why}",
  "test.errorNoReason": "La source n’a pas répondu, sans donner de raison.",
  "test.couldNotRun": "Impossible de lancer le test : {why}",
  "edit.title": "Les réglages d’une source se trouvent dans l’application",
  "edit.body":
    "Changer l’origine d’une source ou ses identifiants se fait dans l’application. La console du serveur affiche la source et la teste ; elle ne la modifie pas.",
  "edit.cta": "Ouvrir les réglages des connecteurs",
};

export const SOURCE_CATALOGS = { en, fr };

/** The drawer's translator in the ambient catalog locale, for the pure model. */
export function sourceT() {
  return createT(ambientCatalogLocale(), SOURCE_CATALOGS);
}
