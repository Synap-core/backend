/**
 * The proposal page's counted sentences, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French, awaiting the founder's
 * review with the vocabulary's (session 1129210f).
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "deferredWrites.count": "{n, plural, one {# write} other {# writes}}",
  "deferredWrites.showAll":
    "Show all {n, plural, one {# write} other {# writes}}",
  "deferredWrites.unreadable":
    "{n, plural, one {# write} other {# writes}} could not be read — the raw request is under Advanced.",
  "toolRun.heading": "{action} · {tool}",
  "toolRun.sends": "What it sends",
  "toolRun.noArguments": "It sends no arguments.",
  "toolRun.secret": "Hidden — a credential",
  "toolRun.empty": "empty",
  "toolRun.yes": "Yes",
  "toolRun.no": "No",
} as const;

export const fr: Catalog<typeof en> = {
  "deferredWrites.count":
    "{n, plural, one {# écriture} many {# d’écritures} other {# écritures}}",
  "deferredWrites.showAll":
    "{n, plural, one {Afficher l’écriture} other {Afficher les # écritures}}",
  "deferredWrites.unreadable":
    "{n, plural, one {# écriture n’a pas pu être lue} other {# écritures n’ont pas pu être lues}}\u00a0: la requête brute est dans Avancé.",
  "toolRun.heading": "{action} · {tool}",
  "toolRun.sends": "Ce qu’il envoie",
  "toolRun.noArguments": "Il n’envoie aucun argument.",
  "toolRun.secret": "Masqué\u00a0: un identifiant",
  "toolRun.empty": "vide",
  "toolRun.yes": "Oui",
  "toolRun.no": "Non",
};

/** The page's translator, in the ambient catalog locale. */
export function proposalPageT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

/**
 * "Approve & always…" (`AlwaysApproveMenu.tsx`): each option says what it
 * covers and what still asks. "Sending, publishing and deleting still ask"
 * is true for every option but "this tool": a broad rule never authorizes a
 * tool run (the outward floor, `resolveGovernanceRule`), and deletes sit
 * under the destructive floor. A rule is taken back from a space's Governance
 * tab, which lists the space's rules and the pod-wide ones.
 */
export const alwaysEn = {
  "always.trigger": "Approve & always…",
  "always.menu": "Approve and keep allowing this",
  "always.capability.label": "Always let agents use “{name}”",
  "always.capability.covers":
    "Agents use this tool without asking you, even when it sends outside your company. Other tools still ask.",
  "always.action.label": "{change}, always",
  "always.action.covers":
    "Any agent makes this change without asking you. Sending, publishing and deleting still ask.",
  "always.profile.label": "Changes to any “{kind}”, always",
  "always.profile.covers":
    "Any agent changes this kind of record without asking you. Sending, publishing and deleting still ask.",
  "always.agent.label": "This change from this agent, always",
  "always.agent.covers":
    "Only this agent, only this change. Other agents still ask you.",
  "always.done.title": "Approved",
  "always.done.body":
    "From now on: {label}. Take it back in Spaces › the space › Governance.",
  "always.ruleFailed": "Approved, but the rule wasn’t saved: {reason}",
  "always.approveFailed": "Couldn’t approve",
  "always.noReason": "no reason given",
} as const;

export const alwaysFr: Catalog<typeof alwaysEn> = {
  "always.trigger": "Approuver et toujours…",
  "always.menu": "Approuver et continuer à l’autoriser",
  "always.capability.label": "Toujours laisser les agents utiliser « {name} »",
  "always.capability.covers":
    "Les agents utilisent cet outil sans vous demander, même pour envoyer hors de votre entreprise. Les autres outils vous sont toujours demandés.",
  "always.action.label": "{change}, toujours",
  "always.action.covers":
    "Tout agent fait ce changement sans vous demander. Envoyer, publier et supprimer vous sont toujours demandés.",
  "always.profile.label": "Les changements de tout « {kind} », toujours",
  "always.profile.covers":
    "Tout agent modifie ce type de fiche sans vous demander. Envoyer, publier et supprimer vous sont toujours demandés.",
  "always.agent.label": "Ce changement par cet agent, toujours",
  "always.agent.covers":
    "Seulement cet agent, seulement ce changement. Les autres agents vous demandent toujours.",
  "always.done.title": "Approuvé",
  "always.done.body":
    "Désormais : {label}. Vous pouvez le retirer dans Espaces › l’espace › Gouvernance.",
  "always.ruleFailed":
    "Approuvé, mais la règle n’a pas été enregistrée : {reason}",
  "always.approveFailed": "Impossible d’approuver",
  "always.noReason": "sans raison donnée",
};

/** The "Approve & always…" menu's translator, in the ambient catalog locale. */
export function alwaysApproveT() {
  return createT(ambientCatalogLocale(), { en: alwaysEn, fr: alwaysFr });
}
