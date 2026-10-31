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
  "read.notFound": "It may have been withdrawn, or the link is out of date.",
  "read.forbidden":
    "You’re signed in, but this request isn’t one you can see. Ask the person who sent you the link.",
  "read.failed": "It didn’t load. Check your connection and try again.",
  "read.retry": "Try again",
  openInDesktop: "Open in the Synap desktop app",
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
  "read.notFound":
    "Elle a peut-être été retirée, ou le lien n’est plus à jour.",
  "read.forbidden":
    "Votre session est ouverte, mais cette demande ne vous est pas visible. Demandez à la personne qui vous a envoyé le lien.",
  "read.failed":
    "Elle ne s’est pas chargée. Vérifiez votre connexion et réessayez.",
  "read.retry": "Réessayer",
  openInDesktop: "Ouvrir dans l’application Synap pour ordinateur",
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
 *
 * "Reject & never…" (`RejectNeverMenu`, same file): rejects the request and
 * stores a deny rule for THIS agent and THIS act (`deriveGovernanceNeverOption`),
 * which the pod refuses from then on without asking (decision 956930ad).
 * `never.reason` is the rejection reason the agent reads.
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
  "never.trigger": "Reject & never…",
  "never.menu": "Reject and refuse this from now on",
  "never.action.label": "This change from this agent, never",
  "never.action.covers":
    "Refused from now on, without asking you. Other agents and other changes still ask.",
  "never.capability.label": "Never let this agent use “{name}”",
  "never.capability.covers":
    "This agent can no longer use this tool, even to read. Other agents still ask you.",
  "never.reason":
    "Refused for good: you will not be allowed to make this change again.",
  "never.done.title": "Rejected",
  "never.done.body":
    "From now on: {label}. Take it back in Spaces › the space › Governance.",
  "never.ruleFailed": "Rejected, but the rule wasn’t saved: {reason}",
  "never.rejectFailed": "Couldn’t reject",
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
  "never.trigger": "Refuser et jamais…",
  "never.menu": "Refuser et le refuser désormais",
  "never.action.label": "Ce changement par cet agent, jamais",
  "never.action.covers":
    "Refusé désormais, sans vous demander. Les autres agents et les autres changements vous sont toujours demandés.",
  "never.capability.label": "Ne jamais laisser cet agent utiliser « {name} »",
  "never.capability.covers":
    "Cet agent ne peut plus utiliser cet outil, même pour lire. Les autres agents vous demandent toujours.",
  "never.reason":
    "Refusé définitivement\u00a0: vous ne pourrez plus faire ce changement.",
  "never.done.title": "Refusé",
  "never.done.body":
    "Désormais : {label}. Vous pouvez le retirer dans Espaces › l’espace › Gouvernance.",
  "never.ruleFailed":
    "Refusé, mais la règle n’a pas été enregistrée : {reason}",
  "never.rejectFailed": "Impossible de refuser",
};

/** The "Approve & always…" and "Reject & never…" menus' translator, in the ambient catalog locale. */
export function alwaysApproveT() {
  return createT(ambientCatalogLocale(), { en: alwaysEn, fr: alwaysFr });
}
