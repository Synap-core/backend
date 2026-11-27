/**
 * The console shell's words (side nav, phone drawer, top bar, shared row
 * states), as catalogs (`@synap-core/types/i18n`): English is the source and
 * the type. The client scope's places speak the client's words (decision
 * G1): Requests ("Demandes"), History ("Historique"), and in French the
 * team ("Équipe"); the operator's groups behind "All tools" stay English
 * (rule i18n §7: a tool stays English until it goes to clients). DRAFT French ("vous"), awaiting
 * the founder's review.
 *
 * `nav.<id>` holds the label of each client place that is not a kind's
 * noun; Agents is the vocabulary's plural (`resolveObjectNounPlural`). The
 * English words equal `lib/console-nav.ts`'s labels, pinned by
 * `shell-copy.test.ts`.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "nav.home": "Home",
  "nav.review": "Requests",
  "nav.history": "History",
  "nav.members": "Members",
  "nav.settings": "Settings",
  "nav.label": "Console",
  "nav.allTools": "All tools",
  "nav.allTools.hint": "Every operator page: jobs, data, keys, server",
  "nav.memberPreview": "Preview member menu",
  "nav.memberPreview.hint":
    "See the menu and Home a member sees. Your access does not change.",
  "memberPreview.title": "Preview of the member’s menu",
  "memberPreview.body":
    "Everything shown is your own data, never a member’s. Your access is unchanged.",
  "memberPreview.stop": "Stop preview",
  "nav.collapse": "Collapse",
  "nav.collapse.aria": "Collapse navigation",
  "nav.expand.aria": "Expand navigation",
  "nav.open.aria": "Open navigation",
  brand: "Synap",
  search: "Search…",
  "search.short": "Search",
  "search.aria": "Open search (⌘K)",
  "user.menu": "Account menu",
  "user.menu.codes": "Account menu: recovery codes not saved",
  "user.menu.first-way": "Account menu: no way to confirm it’s you yet",
  "user.menu.second-way": "Account menu: only one way to confirm it’s you",
  "user.menu.this-device":
    "Account menu: you can set up a passkey on this device",
  "user.signedIn": "Signed in",
  "role.admin": "Administrator",
  "role.member": "Member",
  "user.security": "Security",
  "user.mark.codes": "Save recovery codes",
  "user.mark.first-way": "Add a way in",
  "user.mark.second-way": "Add a second way in",
  "user.mark.this-device": "Set up this device",
  "user.connections": "My connections",
  "user.devices": "My devices",
  "user.notifications": "My notifications",
  "user.vault": "My vault",
  "user.plan": "Plan",
  "user.billing": "Billing",
  "user.support": "Support",
  "user.docs": "Documentation",
  "user.signOut": "Sign out",
  retry: "Retry",
  "listSearch.rules": "Search automations…",
  "rules.anyProcess": "In a process or not",
  "rules.outside": "Outside a process",
  "rules.outsideFailed":
    "Which automations belong to no process couldn’t be read.",
  "listSearch.templates": "Search templates…",
  "listSearch.members": "Search members…",
  "listSearch.agents": "Search agents…",
  "listSearch.none": "Nothing matches “{query}”.",
  "listSearch.partial.templates":
    "Searching the {n, plural, one {# template} other {# templates}} loaded so far. Load more to search further.",
  "listSearch.partial.rules":
    "Searching the {n, plural, one {# automation} other {# automations}} loaded (the 2,000 most recent at most).",
  "list.page": "Page {page} / {count}",
  "list.prev": "Previous page",
  "list.next": "Next page",
  "list.loadMore": "Load more",
  "filter.clear": "Clear {label}",
} as const;

export const fr: Catalog<typeof en> = {
  "nav.home": "Accueil",
  "nav.review": "Demandes",
  "nav.history": "Historique",
  "nav.members": "Équipe",
  "nav.settings": "Réglages",
  "nav.label": "Console",
  "nav.allTools": "Outils avancés",
  "nav.allTools.hint":
    "Toutes les pages de l’opérateur : travaux, données, clés, serveur",
  "nav.memberPreview": "Aperçu du menu membre",
  "nav.memberPreview.hint":
    "Voyez le menu et l’accueil d’un membre. Vos accès ne changent pas.",
  "memberPreview.title": "Aperçu du menu d’un membre",
  "memberPreview.body":
    "Tout ce qui s’affiche est à vous, jamais à un membre. Vos accès ne changent pas.",
  "memberPreview.stop": "Quitter l’aperçu",
  "nav.collapse": "Réduire",
  "nav.collapse.aria": "Réduire la navigation",
  "nav.expand.aria": "Déployer la navigation",
  "nav.open.aria": "Ouvrir la navigation",
  brand: "Synap",
  search: "Rechercher…",
  "search.short": "Rechercher",
  "search.aria": "Ouvrir la recherche (⌘K)",
  "user.menu": "Menu du compte",
  "user.menu.codes": "Menu du compte : codes de secours non enregistrés",
  "user.menu.first-way":
    "Menu du compte : aucun moyen de confirmer que c’est vous",
  "user.menu.second-way":
    "Menu du compte : un seul moyen de confirmer que c’est vous",
  "user.menu.this-device":
    "Menu du compte : vous pouvez configurer une clé d’accès sur cet appareil",
  "user.signedIn": "Compte connecté",
  "role.admin": "Administrateur",
  "role.member": "Membre",
  "user.security": "Sécurité",
  "user.mark.codes": "Enregistrez vos codes de secours",
  "user.mark.first-way": "Ajoutez un moyen",
  "user.mark.second-way": "Ajoutez un deuxième moyen",
  "user.mark.this-device": "Configurer cet appareil",
  "user.connections": "Mes connexions",
  "user.devices": "Mes appareils",
  "user.notifications": "Mes notifications",
  "user.vault": "Mon coffre",
  "user.plan": "Abonnement",
  "user.billing": "Facturation",
  "user.support": "Assistance",
  "user.docs": "Documentation",
  "user.signOut": "Se déconnecter",
  retry: "Réessayer",
  "listSearch.rules": "Rechercher une automatisation…",
  "rules.anyProcess": "Dans un processus ou non",
  "rules.outside": "Hors de tout processus",
  "rules.outsideFailed":
    "Impossible de lire quelles automatisations n’appartiennent à aucun processus.",
  "listSearch.templates": "Rechercher un modèle…",
  "listSearch.members": "Rechercher un membre…",
  "listSearch.agents": "Rechercher un agent…",
  "listSearch.none": "Aucun résultat pour « {query} ».",
  "listSearch.partial.templates":
    "Recherche parmi {n, plural, one {# modèle chargé} other {# modèles chargés}} pour l’instant. Chargez-en plus pour chercher plus loin.",
  "listSearch.partial.rules":
    "Recherche parmi {n, plural, one {# automatisation chargée} other {# automatisations chargées}} (2 000 au plus, les plus récentes).",
  "list.page": "Page {page} / {count}",
  "list.prev": "Page précédente",
  "list.next": "Page suivante",
  "list.loadMore": "Charger plus",
  "filter.clear": "Effacer {label}",
};

/** The words' translator, in the ambient catalog locale. */
export function shellT() {
  return createT(ambientCatalogLocale(), { en, fr });
}
