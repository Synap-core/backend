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
  "read.notFound.title": "This request couldn’t be found",
  "read.notFound": "It may have been withdrawn, or the link is out of date.",
  "read.forbidden.title": "You don’t have access to this request",
  "read.forbidden":
    "You’re signed in, but this request isn’t one you can see. Ask the person who sent you the link.",
  "read.failed.title": "This request couldn’t be loaded",
  "read.failed": "It didn’t load. Check your connection and try again.",
  "read.loading": "Reading the request…",
  "read.signIn.title": "Signing you in",
  "read.signIn": "You’re signed out. Taking you to sign in…",
  "read.retry": "Try again",
  openInDesktop: "Open in the Synap desktop app",
  "decide.cancel": "Cancel",
  "decide.reason.label": "Reason (optional)",
  "decide.reason.placeholder": "Why are you rejecting this? The AI sees it.",
  "decide.pickFirst": "Pick the record for each item first.",
  "decide.as": "You decide as {identity} · recorded in the",
  "decide.recorded": "Recorded in the",
  "outcome.approved": "You approved this change: it’s now in your pod.",
  "outcome.auto_approved":
    "This matched an auto-approve rule and is already applied.",
  "outcome.rejected": "You rejected this: the AI was told why.",
  "outcome.reverted": "This change was undone after it was applied.",
  "outcome.expired":
    "Its moment passed before anyone decided: nothing was applied.",
  "outcome.withdrawn": "The AI withdrew this request: nothing was applied.",
  "repair.label": "Why approving failed",
  "repair.default": "Approving this failed.",
  "repair.loadFailed": "Couldn’t load what can be fixed.",
  "repair.checking": "Checking what to fix…",
  "repair.use": "Use “{value}” and approve",
  "repair.add": "Add “{value}” as a choice and approve",
  "repair.missingKind":
    "The kind “{kind}” does not exist here. Create it, or ask the AI to file this under a kind that exists.",
  "repair.approved": "Repaired and approved",
  "repair.approveFailed": "Repaired, but couldn’t approve",
  "repair.failed": "Couldn’t repair this request",
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
  "read.notFound.title": "Cette demande est introuvable",
  "read.notFound":
    "Elle a peut-être été retirée, ou le lien n’est plus à jour.",
  "read.forbidden.title": "Vous n’avez pas accès à cette demande",
  "read.forbidden":
    "Cette demande n’est pas visible depuis votre compte. Demandez à la personne qui vous a envoyé le lien.",
  "read.failed.title": "Cette demande ne s’est pas chargée",
  "read.failed":
    "Elle ne s’est pas chargée. Vérifiez votre connexion et réessayez.",
  "read.loading": "Lecture de la demande…",
  "read.signIn.title": "Connexion",
  "read.signIn": "Votre compte n’est plus connecté. Ouverture de la connexion…",
  "read.retry": "Réessayer",
  openInDesktop: "Ouvrir dans l’application Synap pour ordinateur",
  "decide.cancel": "Annuler",
  "decide.reason.label": "Raison (facultatif)",
  "decide.reason.placeholder":
    "Pourquoi rejetez-vous cette demande\u00a0? L’IA la lira.",
  "decide.pickFirst": "Choisissez d’abord la fiche de chaque élément.",
  "decide.as": "Vous décidez en tant que {identity} · enregistré dans",
  "decide.recorded": "Enregistré dans",
  "outcome.approved":
    "Vous avez approuvé ce changement\u00a0: il est maintenant dans votre pod.",
  "outcome.auto_approved":
    "Cette demande correspondait à une règle d’approbation automatique et est déjà appliquée.",
  "outcome.rejected":
    "Vous avez rejeté cette demande\u00a0: l’IA a été prévenue du motif.",
  "outcome.reverted": "Ce changement a été annulé après son application.",
  "outcome.expired":
    "Le délai est passé avant toute décision\u00a0: rien n’a été appliqué.",
  "outcome.withdrawn":
    "L’IA a retiré cette demande\u00a0: rien n’a été appliqué.",
  "repair.label": "Pourquoi l’approbation a échoué",
  "repair.default": "L’approbation a échoué.",
  "repair.loadFailed": "Impossible de charger ce qui peut être corrigé.",
  "repair.checking": "Recherche de ce qu’il faut corriger…",
  "repair.use": "Utiliser «\u00a0{value}\u00a0» et approuver",
  "repair.add": "Ajouter «\u00a0{value}\u00a0» comme choix et approuver",
  "repair.missingKind":
    "Le type «\u00a0{kind}\u00a0» n’existe pas ici. Créez-le, ou demandez à l’IA de classer cette demande sous un type qui existe.",
  "repair.approved": "Corrigée et approuvée",
  "repair.approveFailed": "Corrigée, mais impossible de l’approuver",
  "repair.failed": "Impossible de corriger cette demande",
};

/** The catalog keys of a decided request's one-line outcome. */
export type OutcomeKey = Extract<keyof typeof en, `outcome.${string}`>;

/** The page's translator, in the ambient catalog locale. */
export function proposalPageT() {
  return createT(ambientCatalogLocale(), { en, fr });
}

/**
 * "Approve and always allow…" (`AlwaysApproveMenu.tsx`): each option says
 * what it covers and what still asks. "Sending, publishing and deleting still
 * ask" is true for every option but "this tool" and a session's tool grant: a
 * broad rule never authorizes a tool run (the outward floor,
 * `resolveGovernanceRule`), and deletes sit under the destructive floor. A
 * rule on the grant itself names the write, so the grant goes through and the
 * tools it hands out then run without asking (`always.grant.covers`). A rule
 * is taken back from a space's Governance tab, which lists the space's rules
 * and the pod-wide ones. The decision's title is the receipt's
 * (`_lib/receipt`).
 *
 * "Reject and never allow…" (`RejectNeverMenu`, same file): stores a deny rule
 * for THIS agent and THIS act, pod-wide (`deriveGovernanceNeverOption`), then
 * rejects the request; the pod refuses that act from then on without asking
 * (decision 956930ad). Both rules are taken back in Settings.
 * `never.reason` is the rejection reason the agent reads.
 */
export const alwaysEn = {
  "always.trigger": "Approve and always allow…",
  "always.menu": "Approve and keep allowing this",
  "always.capability.label": "Always let your AIs use “{name}”",
  "always.capability.covers":
    "Your AIs use this tool without asking you, even when it sends outside your company. Other tools still ask.",
  "always.action.label": "{change}, always",
  "always.action.covers":
    "Your AIs make this change without asking you. Sending, publishing and deleting still ask.",
  "always.profile.label": "Changes to any “{kind}”, always",
  "always.profile.covers":
    "Your AIs change this kind of record without asking you. Sending, publishing and deleting still ask.",
  "always.agent.label": "This change from this AI, always",
  "always.agent.covers":
    "Only this AI, only this change. Your other AIs still ask you.",
  "always.grant.covers":
    "Your AIs get tools for their work without asking you, and what those tools send then goes without asking too.",
  "always.grantAgent.covers":
    "Only this AI gets tools without asking you, and what those tools send then goes without asking too.",
  "always.done.body": "From now on: {label}. Take it back in Settings.",
  "always.ruleSaved": "Rule saved",
  "always.ruleFailed": "Approved, but the rule wasn’t saved",
  "always.ruleFailedHint": "The next request like this one will ask you again.",
  "never.trigger": "Reject and never allow…",
  "never.menu": "Reject and refuse this from now on",
  "never.action.label": "This change from this AI, never",
  "never.action.covers":
    "Refused from now on, without asking you. Your other AIs and other changes still ask.",
  "never.capability.label": "Never let this AI use “{name}”",
  "never.capability.covers":
    "This AI can no longer use this tool, even to read. Your other AIs still ask you.",
  "never.reason":
    "Refused for good: you will not be allowed to make this change again.",
  "never.done.body": "From now on: {label}. Take it back in Settings.",
  "never.ruleFailed": "Nothing changed: the rule wasn’t saved",
  "never.ruleFailedHint": "This request is still waiting for you.",
  "never.rejectFailed": "Refused from now on, but this request is still open",
} as const;

export const alwaysFr: Catalog<typeof alwaysEn> = {
  "always.trigger": "Approuver et toujours autoriser…",
  "always.menu": "Approuver et continuer à l’autoriser",
  "always.capability.label": "Toujours laisser vos IA utiliser « {name} »",
  "always.capability.covers":
    "Vos IA utilisent cet outil sans vous demander, même pour envoyer hors de votre entreprise. Les autres outils vous sont toujours demandés.",
  "always.action.label": "{change}, toujours",
  "always.action.covers":
    "Vos IA font ce changement sans vous demander. Envoyer, publier et supprimer vous sont toujours demandés.",
  "always.profile.label": "Toute modification du type « {kind} », toujours",
  "always.profile.covers":
    "Vos IA modifient ce type de fiche sans vous demander. Envoyer, publier et supprimer vous sont toujours demandés.",
  "always.agent.label": "Ce changement par cette IA, toujours",
  "always.agent.covers":
    "Seulement cette IA, seulement ce changement. Vos autres IA vous demandent toujours.",
  "always.grant.covers":
    "Vos IA obtiennent des outils pour leur travail sans vous demander, et ce que ces outils envoient part alors sans vous demander.",
  "always.grantAgent.covers":
    "Seule cette IA obtient des outils sans vous demander, et ce que ces outils envoient part alors sans vous demander.",
  "always.done.body":
    "Désormais\u00a0: {label}. Vous pouvez le retirer dans Réglages.",
  "always.ruleSaved": "Règle enregistrée",
  "always.ruleFailed": "Approuvée, mais la règle n’a pas été enregistrée",
  "always.ruleFailedHint":
    "La prochaine demande comme celle-ci vous sera de nouveau soumise.",
  "never.trigger": "Rejeter et ne plus autoriser…",
  "never.menu": "Rejeter et ne plus l’autoriser",
  "never.action.label": "Ce changement par cette IA, jamais",
  "never.action.covers":
    "Refusé désormais, sans vous demander. Vos autres IA et les autres changements vous sont toujours demandés.",
  "never.capability.label": "Ne jamais laisser cette IA utiliser « {name} »",
  "never.capability.covers":
    "Cette IA ne peut plus utiliser cet outil, même pour lire. Vos autres IA vous demandent toujours.",
  "never.reason":
    "Refusé définitivement\u00a0: vous ne pourrez plus faire ce changement.",
  "never.done.body":
    "Désormais\u00a0: {label}. Vous pouvez le retirer dans Réglages.",
  "never.ruleFailed": "Rien n’a changé\u00a0: la règle n’a pas été enregistrée",
  "never.ruleFailedHint": "Cette demande vous attend toujours.",
  "never.rejectFailed": "Refusé désormais, mais cette demande reste ouverte",
};

/** The "Approve & always…" and "Reject & never…" menus' translator, in the ambient catalog locale. */
export function alwaysApproveT() {
  return createT(ambientCatalogLocale(), { en: alwaysEn, fr: alwaysFr });
}
