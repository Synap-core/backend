/**
 * The words of the app consent (design A: "It can", "In", "It changes
 * things in"), its short ask and the app page's access lines, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French, awaiting the founder's review. Names (an app's, a space's) and the
 * developer's reasons are content: they are passed in, never translated.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "title.connect": "Connect {name} to your pod?",
  "title.confirm": "Confirm {name}’s access",
  "line.can": "It can",
  "line.in": "In",
  "line.write": "It changes things in",
  "door.review": "Review",
  "door.change": "Change",
  "door.pick": "Pick",
  "mark.changed": "Changed",
  "mark.unchanged": "Unchanged",
  "mark.new": "New",
  "level.view": "View",
  "level.edit": "Edit",
  "level.on": "On",
  "can.nothing": "Nothing yet",
  "write.pickWhere": "Pick where",
  "write.undeclared": "{name} declared no space for its changes.",
  "sheet.can": "What it can do",
  "sheet.canHint": "Set any of these to Off. It can only ask again.",
  "sheet.in": "Where it can look",
  "sheet.write": "Where it can make changes",
  "sheet.done": "Done",
  "sheet.cancel": "Cancel",
  "sheet.save": "Save",
  "sheet.close": "Close",
  "in.spaces": "Spaces",
  "in.allSpaces": "All spaces",
  "in.allSpacesHint": "Includes spaces you create later.",
  "in.pickSpaces": "Only the spaces I pick",
  "in.projects": "Projects",
  "in.allProjects": "All projects",
  "in.allProjectsHint": "Includes projects you create later.",
  "in.allProjectsNoneYet":
    "You have no projects yet. This includes the ones you create later.",
  "in.pickProjects": "Only the projects I pick",
  "in.noProjects": "No projects",
  "in.everyProject":
    "Every project is included: “All spaces” already reaches records filed in a project, and ones outside any space.",
  "in.notEverywhere":
    "With all spaces it still cannot see {names}: those hold only in spaces you pick.",
  "in.nowhere": "Nowhere yet",
  "in.every": "Every space and every project, including ones you create later",
  "in.union":
    "It reaches a record when it is in a space you picked, or filed in a project you picked. A project’s records outside your picked spaces are included.",
  "write.spaces": "Spaces",
  "write.projects": "Projects",
  "write.asked": "Asked",
  "write.viewOnly":
    "{names} {n, plural, one {isn’t listed: you can only view it.} other {aren’t listed: you can only view them.}}",
  "write.noEverywhere":
    "Pick each place. There is no “everywhere” for changes.",
  "write.noPlace": "You have no space where it could make changes.",
  "kinds.count": "{n, plural, one {# kind} other {# kinds}}",
  "kinds.all": "All {n} kinds it asked for",
  "kinds.on": "{n} on",
  "kinds.note": "One request. Each kind is still its own permission.",
  "kinds.label": "Kinds of records",
  "reason.prefix": "Its reason:",
  "reconsent.title":
    "{n, plural, one {One thing to confirm} other {# things to confirm}}",
  "reconsent.body":
    "Synap now keeps one “where” per app. Your earlier choices for {name} don’t fit it exactly. It keeps working as before until you confirm.",
  "reconsent.was": "was {where}",
  "reconsent.turnedOff": "turned off",
  "reconsent.undo": "Undo",
  "reconsent.rest": "Everything else stays as you allowed it.",
  "reconsent.new": "New since you last allowed",
  "reconsent.allowNew": "Allow the new ones",
  "reconsent.wider": "Wider",
  "reconsent.narrower": "Narrower",
  "cant.title":
    "{n, plural, one {It also asked for # thing you can’t give} other {It also asked for # things you can’t give}}",
  "cant.notGiven": "Not given",
  "cant.rest":
    "It still connects with the rest. If it needs these, it will tell you.",
  "facts.sendsBack": "Sends you back to",
  "facts.firstSeen": "First seen",
  "act.allow": "Allow",
  "act.decline": "Decline",
  "act.confirm": "Confirm",
  "act.notNow": "Not now",
  "act.tryAgain": "Try again",
  "allowFailed.title": "Couldn’t connect {name}",
  "allowFailed.hint": "Nothing was given. Your choices are kept.",
  "revoke.before": "You can change or revoke it any time from",
  "revoke.link": "Connected",
  "revoke.after":
    ". Revoking there stops it in every browser, not just this one.",
  "loading.label": "Loading what this app asks for",
  "readFailed.title": "Couldn’t read what this app asks for",
  "readFailed.hint": "Your pod did not answer. Nothing was given.",
  "readFailed.decline": "Decline and go back",
  "ask.title":
    "{name} asks for {n, plural, one {one more thing} other {# more things}}",
  "ask.where": "in {where}",
  "ask.stays":
    "Asking for more never changes where it works. To change that, open",
  "ask.page": "its page",
  "ask.pickFor": "Pick where it can make this change",
  "ask.newChoice": "It changes nothing yet, so this is a new choice.",
  "ask.blocked": "Pick at least one place for it.",
  "ask.unavailable":
    "It also asked for something none of your spaces can hold; that part is left out.",
  "ask.keeps": "What it already has stays as it is.",
  "page.heading": "Access",
  "page.applies":
    "A change applies at its next request. It can never get more than it asked for; to give more, it asks again.",
  "page.narrowOnly":
    "You can take things away here. To give more, it asks again.",
  "page.saved": "Access changed",
  "page.saveFailed": "Couldn’t change its access",
  "page.undone": "Change undone",
  "page.undoFailed": "Couldn’t undo the change",
  "page.unsaved": "Unsaved changes",
  "page.confirmTitle": "Take this away from {name}?",
  "page.confirmBody":
    "{name} loses it now. Its current access stops; the next one it gets carries only what is left. To give it back, it asks again.",
  "page.revokeInstead": "To take everything away, revoke it.",
  "page.confirmLaterTitle": "One thing to confirm",
  "page.confirmLater":
    "It keeps working as before. You confirm the new form the next time you sign in to it.",
  "blocked.noSpace": "You have no space to give it yet.",
  "blocked.nothing": "Turn on at least one thing it asks for.",
  "blocked.writeOrView":
    "Pick where it can make changes, or set {names} to View.",
  "blocked.write": "Pick where it can make changes.",
  "blocked.read": "Pick at least one space or project it can work in.",
  "reconsent.keepKinds": "Keep to the {n} kinds",
  "reconsent.turnOff": "Turn {what} off",
  "reconsent.noLonger": "no longer {where}",
  "reconsent.nowhere": "nowhere",
  "cant.ignored": "Apps are never given this.",
  "cant.noWriteSpace":
    "You have no space where you can let it make this change.",
  "cant.noReadSpace": "You have no space where you can let it see this.",
} as const;

export const fr: Catalog<typeof en> = {
  "title.connect": "Connecter {name} à votre pod ?",
  "title.confirm": "Confirmer l’accès de {name}",
  "line.can": "Il peut",
  "line.in": "Dans",
  "line.write": "Il modifie dans",
  "door.review": "Vérifier",
  "door.change": "Modifier",
  "door.pick": "Choisir",
  "mark.changed": "Modifié",
  "mark.unchanged": "Inchangé",
  "mark.new": "Nouveau",
  "level.view": "Voir",
  "level.edit": "Modifier",
  "level.on": "Activé",
  "can.nothing": "Rien pour l’instant",
  "write.pickWhere": "Choisir où",
  "write.undeclared": "{name} n’a déclaré aucun espace pour ses modifications.",
  "sheet.can": "Ce qu’il peut faire",
  "sheet.canHint":
    "Désactivez ce que vous voulez. Il pourra seulement redemander.",
  "sheet.in": "Où il peut regarder",
  "sheet.write": "Où il peut faire des modifications",
  "sheet.done": "Terminé",
  "sheet.cancel": "Annuler",
  "sheet.save": "Enregistrer",
  "sheet.close": "Fermer",
  "in.spaces": "Espaces",
  "in.allSpaces": "Tous les espaces",
  "in.allSpacesHint": "Y compris les espaces que vous créerez.",
  "in.pickSpaces": "Seulement les espaces que je choisis",
  "in.projects": "Projets",
  "in.allProjects": "Tous les projets",
  "in.allProjectsHint": "Y compris les projets que vous créerez.",
  "in.allProjectsNoneYet":
    "Vous n’avez pas encore de projet. Cela inclut ceux que vous créerez.",
  "in.pickProjects": "Seulement les projets que je choisis",
  "in.noProjects": "Aucun projet",
  "in.everyProject":
    "Chaque projet est inclus : « Tous les espaces » atteint déjà les fiches classées dans un projet, et celles hors de tout espace.",
  "in.notEverywhere":
    "Avec tous les espaces, il ne voit toujours pas {names} : ils ne valent que dans les espaces que vous choisissez.",
  "in.nowhere": "Nulle part pour l’instant",
  "in.every": "Chaque espace et chaque projet, y compris ceux que vous créerez",
  "in.union":
    "Il atteint une fiche lorsqu’elle est dans un espace choisi, ou classée dans un projet choisi. Les fiches d’un projet hors de vos espaces choisis sont incluses.",
  "write.spaces": "Espaces",
  "write.projects": "Projets",
  "write.asked": "Demandé",
  "write.viewOnly":
    "{names} {n, plural, one {n’apparaît pas : vous pouvez seulement le consulter.} other {n’apparaissent pas : vous pouvez seulement les consulter.}}",
  "write.noEverywhere":
    "Choisissez chaque lieu. Il n’y a pas de « partout » pour les modifications.",
  "write.noPlace":
    "Vous n’avez aucun espace où il pourrait faire des modifications.",
  "kinds.count": "{n, plural, one {# type} other {# types}}",
  "kinds.all": "Les {n} types demandés",
  "kinds.on": "{n} activés",
  "kinds.note": "Une seule demande. Chaque type reste une permission à part.",
  "kinds.label": "Types de fiches",
  "reason.prefix": "Sa raison :",
  "reconsent.title":
    "{n, plural, one {Un point à confirmer} other {# points à confirmer}}",
  "reconsent.body":
    "Synap garde désormais un seul « où » par app. Vos choix précédents pour {name} n’y correspondent pas exactement. Il continue de fonctionner comme avant jusqu’à votre confirmation.",
  "reconsent.was": "avant : {where}",
  "reconsent.turnedOff": "désactivé",
  "reconsent.undo": "Annuler",
  "reconsent.rest": "Tout le reste reste comme vous l’aviez autorisé.",
  "reconsent.new": "Nouveau depuis votre dernière autorisation",
  "reconsent.allowNew": "Autoriser les nouveautés",
  "reconsent.wider": "Plus large",
  "reconsent.narrower": "Plus étroit",
  "cant.title":
    "{n, plural, one {Il a aussi demandé # chose que vous ne pouvez pas donner} other {Il a aussi demandé # choses que vous ne pouvez pas donner}}",
  "cant.notGiven": "Non accordé",
  "cant.rest":
    "Il se connecte quand même avec le reste. S’il en a besoin, il vous le dira.",
  "facts.sendsBack": "Vous renvoie vers",
  "facts.firstSeen": "Vu pour la première fois",
  "act.allow": "Autoriser",
  "act.decline": "Refuser",
  "act.confirm": "Confirmer",
  "act.notNow": "Pas maintenant",
  "act.tryAgain": "Réessayer",
  "allowFailed.title": "Impossible de connecter {name}",
  "allowFailed.hint": "Rien n’a été accordé. Vos choix sont gardés.",
  "revoke.before":
    "Vous pouvez le modifier ou le révoquer à tout moment depuis",
  "revoke.link": "Connectés",
  "revoke.after":
    ". Le révoquer là-bas l’arrête dans tous les navigateurs, pas seulement celui-ci.",
  "loading.label": "Chargement de ce que cette app demande",
  "readFailed.title": "Impossible de lire ce que cette app demande",
  "readFailed.hint": "Votre pod n’a pas répondu. Rien n’a été accordé.",
  "readFailed.decline": "Refuser et revenir",
  "ask.title":
    "{name} demande {n, plural, one {une chose de plus} other {# choses de plus}}",
  "ask.where": "dans {where}",
  "ask.stays":
    "Demander plus ne change jamais où il travaille. Pour changer cela, ouvrez",
  "ask.page": "sa page",
  "ask.pickFor": "Choisissez où il peut faire cette modification",
  "ask.newChoice":
    "Il ne modifie rien pour l’instant, c’est donc un nouveau choix.",
  "ask.blocked": "Choisissez au moins un lieu.",
  "ask.unavailable":
    "Il a aussi demandé quelque chose qu’aucun de vos espaces ne peut accueillir ; cette partie est laissée de côté.",
  "ask.keeps": "Ce qu’il a déjà reste tel quel.",
  "page.heading": "Accès",
  "page.applies":
    "Une modification s’applique à sa prochaine requête. Il ne peut jamais obtenir plus que ce qu’il a demandé ; pour donner plus, il redemande.",
  "page.narrowOnly":
    "Vous pouvez retirer des accès ici. Pour en donner plus, il redemande.",
  "page.saved": "Accès modifié",
  "page.saveFailed": "Impossible de modifier son accès",
  "page.undone": "Modification annulée",
  "page.undoFailed": "Impossible d’annuler la modification",
  "page.unsaved": "Modifications non enregistrées",
  "page.confirmTitle": "Retirer cet accès à {name} ?",
  "page.confirmBody":
    "{name} le perd maintenant. Son accès actuel s’arrête ; le prochain ne contient que ce qui reste. Pour le lui rendre, il redemande.",
  "page.revokeInstead": "Pour tout retirer, révoquez-le.",
  "page.confirmLaterTitle": "Un point à confirmer",
  "page.confirmLater":
    "Il continue de fonctionner comme avant. Vous confirmerez la nouvelle forme à votre prochaine connexion.",
  "blocked.noSpace": "Vous n’avez pas encore d’espace à lui donner.",
  "blocked.nothing": "Activez au moins une chose qu’il demande.",
  "blocked.writeOrView":
    "Choisissez où il peut faire des modifications, ou réglez {names} sur Voir.",
  "blocked.write": "Choisissez où il peut faire des modifications.",
  "blocked.read":
    "Choisissez au moins un espace ou un projet où il peut travailler.",
  "reconsent.keepKinds": "Garder les {n} types",
  "reconsent.turnOff": "Désactiver : {what}",
  "reconsent.noLonger": "plus {where}",
  "reconsent.nowhere": "nulle part",
  "cant.ignored": "Les apps ne reçoivent jamais cela.",
  "cant.noWriteSpace":
    "Vous n’avez aucun espace où vous pouvez le laisser faire cette modification.",
  "cant.noReadSpace":
    "Vous n’avez aucun espace où vous pouvez le laisser voir cela.",
};

/** The consent's translator, in the ambient catalog locale. */
export function consentT() {
  return createT(ambientCatalogLocale(), { en, fr });
}
