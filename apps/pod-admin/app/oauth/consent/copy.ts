/**
 * The words of the app consent (design A: "It can", "In", "It changes
 * things in"), its short ask and the app page's access lines, as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. DRAFT
 * French, awaiting the founder's review. Names (an app's, a space's) and the
 * developer's reasons are content: they are passed in, never translated.
 * Every place phrase ("in Builder", "everywhere in your pod") is a message
 * here, so no English is ever injected into a French sentence.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  "eyebrow.connection": "Connection request",
  "eyebrow.access": "Access request",
  "tier.verified": "Synap app",
  "tier.unverified": "Unverified app",
  "who.callsItself": "Calls itself “{name}”.",
  "who.podAs": "To your pod {host}, as {identity}.",
  "who.pod": "To your pod {host}.",
  "who.yourPod": "To your pod.",
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
  "level.mixed": "Mixed",
  "can.nothing": "Nothing yet",
  "can.records":
    "{n, plural, one {records (# kind)} other {records (# kinds)}}",
  "can.more": "{n, plural, one {# more} other {# more}}",
  "can.notDecide": "Not allowed to {what}",
  "can.onlyPicked": "{names}: only in spaces you pick",
  "list.and": " and ",
  "list.or": ", or ",
  "place.in": "in {name}",
  "place.inProject": "in project {name}",
  "place.project": "project {name}",
  "place.everywhere": "everywhere in your pod",
  "place.everyProject": "in every project",
  "place.goneSpace": "a space you no longer see",
  "place.goneProject": "a project you no longer see",
  "headline.sees": "Sees {what} {where}.",
  "headline.seesEverywhere": "Sees {what} everywhere in your pod.",
  "headline.changes": "Changes {what} in {where}.",
  "headline.changesPick": "Wants to change {what} (pick where).",
  "headline.nothing": "Nothing is given yet.",
  "write.pickWhere": "Pick where",
  "write.undeclared": "{name} declared no space for its changes.",
  "sheet.can": "What it can do",
  "sheet.canHint":
    "Turn off anything you don’t want. It has to ask you again to get it back.",
  "sheet.in": "Where it can look",
  "sheet.write": "Where it can make changes",
  "sheet.done": "Done",
  "sheet.cancel": "Cancel",
  "sheet.save": "Save",
  "sheet.close": "Close",
  "fine.toggle": "Fine-tune",
  "fine.label": "{object}: each permission",
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
  "in.allIncludesProjects":
    "Every project is included: “All spaces” already reaches records filed in a project, and ones outside any space.",
  "in.everyProject": "every project, including new ones",
  "in.notEverywhere":
    "With all spaces it still cannot see {names}: those hold only in spaces you pick.",
  "in.nowhere": "Nowhere yet",
  "in.every": "Every space and every project, including ones you create later",
  "in.union":
    "It reaches a record when it is in a space you picked, or filed in a project you picked. A project’s records outside your picked spaces are included.",
  "write.spaces": "Spaces it can change things in",
  "write.projects": "Projects it can change things in",
  "write.asked": "Asked",
  "write.viewOnly":
    "{names} {n, plural, one {isn’t listed: you can only view it.} other {aren’t listed: you can only view them.}}",
  "write.noEverywhere":
    "Pick each place. There is no “everywhere” for changes.",
  "write.noPlace": "You have no space where it could make changes.",
  "kinds.count": "{n, plural, one {# kind} other {# kinds}}",
  "kinds.all": "All {n} kinds it asked for",
  "kinds.someOn": "{on} of {n} on",
  "kinds.label": "Kinds of records",
  "kinds.access": "{kind}: access",
  "kinds.podWide":
    "{names}: kept across your whole pod, not in one space. In the spaces you pick it reaches them only through a role there, or when they were filed there.",
  "reason.prefix": "Its reason:",
  "dev.toggle": "Details for developers",
  "reconsent.title":
    "{n, plural, one {# change to confirm} other {# changes to confirm}}",
  "reconsent.body":
    "{name}’s access needs a quick check: {n, plural, one {one thing would} other {# things would}} reach a bit further. Nothing changes until you confirm.",
  "reconsent.nowWas": "now {now} (was {was})",
  "reconsent.turnedOff": "turned off",
  "reconsent.undo": "Undo",
  "reconsent.rest": "Everything else stays as you allowed it.",
  "reconsent.new":
    "{n, plural, one {# new request} other {# new requests}} since you last allowed",
  "reconsent.allowNew": "Allow the new ones",
  "reconsent.wider": "Wider",
  "reconsent.narrower": "Narrower",
  "reconsent.keepKinds": "Keep to the {n} kinds",
  "reconsent.turnOffEverywhere": "Turn {what} off everywhere",
  "reconsent.noLonger": "no longer {where}",
  "reconsent.nowhere": "nowhere",
  "cant.title":
    "{n, plural, one {It also asked for # thing you can’t give} other {It also asked for # things you can’t give}}",
  "cant.notGiven": "Not given",
  "cant.rest":
    "It still connects with the rest. If it needs these, it will tell you.",
  "cant.ignored": "Apps are never given this.",
  "cant.noWriteSpace":
    "You have no space where you can let it make this change.",
  "cant.noReadSpace": "You have no space where you can let it see this.",
  "create.none":
    "Create a space in Synap (or ask for edit rights in one), then reload this page.",
  "create.offer": "Create a space it can work in:",
  "create.from": "Create a space from “{name}”",
  "create.proposed":
    "Creating the space was sent for review. Approve it, then reload this page.",
  "create.refused": "This space can’t be created here.",
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
  "blocked.noSpace": "You have no space to give it yet.",
  "blocked.nothing": "Turn on at least one thing it asks for.",
  "blocked.onlyPicked":
    "{names} can only be given in spaces you pick: pick spaces under In, or turn on something else.",
  "blocked.writeOrView":
    "Pick where it can make changes, or set {names} to View.",
  "blocked.write": "Pick where it can make changes.",
  "blocked.read": "Pick at least one space or project it can work in.",
  "ask.title":
    "{name} asks for {n, plural, one {one more thing} other {# more things}}",
  "ask.line": "{what} {where}",
  "ask.stays":
    "Asking for more never changes where it works. To change that, open",
  "ask.page": "its page",
  "ask.pickFor": "Pick where it can make this change",
  "ask.newChoice": "It changes nothing yet, so this is a new choice.",
  "ask.withinIn": "Only places it can already look in are listed.",
  "ask.blocked": "Pick at least one place for it.",
  "ask.unavailableBlocked":
    "Part of this ask is somewhere it doesn’t work yet: connect it again to choose its places.",
  "ask.unavailable":
    "It also asked for something none of your spaces can hold; that part is left out.",
  "ask.keeps": "What it already has stays as it is.",
  "page.heading": "Access",
  "page.narrowOnly":
    "A change applies now: its current access stops, and the next one carries only what you left. You can take things away here; to give more, it asks again.",
  "page.projectsLocked":
    "It also reaches projects, which this page can’t change yet. To change its access, connect it again from the app.",
  "page.saved": "Access changed",
  "page.saveFailed": "Couldn’t change its access",
  "page.unsaved": "You have unsaved changes.",
  "page.discard": "Discard",
  "page.keepEditing": "Keep editing",
  "page.confirmTitle": "Take this away from {name}?",
  "page.confirmBody":
    "{name} loses it now. Its current access stops; the next one carries only what is left. To give it back, it asks again.",
  "page.takeAway": "Take away",
  "page.revokeInstead": "To take everything away, revoke it.",
  "page.confirmLaterTitle": "One thing to confirm",
  "page.confirmLater":
    "It keeps working as before. You confirm the new form the next time you sign in to it.",
} as const;

export const fr: Catalog<typeof en> = {
  "eyebrow.connection": "Demande de connexion",
  "eyebrow.access": "Demande d’accès",
  "tier.verified": "App Synap",
  "tier.unverified": "App non vérifiée",
  "who.callsItself": "Se présente comme « {name} ».",
  "who.podAs": "Vers votre pod {host}, en tant que {identity}.",
  "who.pod": "Vers votre pod {host}.",
  "who.yourPod": "Vers votre pod.",
  "title.connect": "Connecter {name} à votre pod ?",
  "title.confirm": "Confirmer l’accès de {name}",
  "line.can": "Il peut",
  "line.in": "Dans",
  "line.write": "Il modifie dans",
  "door.review": "Vérifier",
  "door.change": "Changer",
  "door.pick": "Choisir",
  "mark.changed": "Modifié",
  "mark.unchanged": "Inchangé",
  "mark.new": "Nouveau",
  "level.view": "Voir",
  "level.edit": "Modifier",
  "level.on": "Activé",
  "level.mixed": "Mixte",
  "can.nothing": "Rien pour l’instant",
  "can.records":
    "{n, plural, one {des fiches (# type)} other {des fiches (# types)}}",
  "can.more": "{n, plural, one {# autre} other {# autres}}",
  "can.notDecide": "Non autorisé : {what}",
  "can.onlyPicked": "{names} : seulement dans les espaces choisis",
  "list.and": " et ",
  "list.or": ", ou ",
  "place.in": "dans {name}",
  "place.inProject": "dans le projet {name}",
  "place.project": "le projet {name}",
  "place.everywhere": "partout dans votre pod",
  "place.everyProject": "dans chaque projet",
  "place.goneSpace": "un espace que vous ne voyez plus",
  "place.goneProject": "un projet que vous ne voyez plus",
  "headline.sees": "Voit {what} {where}.",
  "headline.seesEverywhere": "Voit {what} partout dans votre pod.",
  "headline.changes": "Modifie {what} dans {where}.",
  "headline.changesPick": "Veut modifier {what} (choisissez où).",
  "headline.nothing": "Rien n’est encore accordé.",
  "write.pickWhere": "Choisir où",
  "write.undeclared": "{name} n’a déclaré aucun espace pour ses modifications.",
  "sheet.can": "Ce qu’il peut faire",
  "sheet.canHint":
    "Désactivez ce que vous ne voulez pas. Il devra vous le redemander pour le récupérer.",
  "sheet.in": "Où il peut regarder",
  "sheet.write": "Où il peut faire des modifications",
  "sheet.done": "Terminé",
  "sheet.cancel": "Annuler",
  "sheet.save": "Enregistrer",
  "sheet.close": "Fermer",
  "fine.toggle": "Affiner",
  "fine.label": "{object} : chaque permission",
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
  "in.allIncludesProjects":
    "Chaque projet est inclus : « Tous les espaces » atteint déjà les fiches classées dans un projet, et celles hors de tout espace.",
  "in.everyProject": "chaque projet, y compris les nouveaux",
  "in.notEverywhere":
    "Avec tous les espaces, il ne voit toujours pas {names} : ils ne valent que dans les espaces que vous choisissez.",
  "in.nowhere": "Nulle part pour l’instant",
  "in.every": "Chaque espace et chaque projet, y compris ceux que vous créerez",
  "in.union":
    "Il atteint une fiche lorsqu’elle est dans un espace choisi, ou classée dans un projet choisi. Les fiches d’un projet hors de vos espaces choisis sont incluses.",
  "write.spaces": "Espaces où il peut modifier",
  "write.projects": "Projets où il peut modifier",
  "write.asked": "Demandé",
  "write.viewOnly":
    "{names} {n, plural, one {n’apparaît pas : vous pouvez seulement le consulter.} other {n’apparaissent pas : vous pouvez seulement les consulter.}}",
  "write.noEverywhere":
    "Choisissez chaque lieu. Il n’y a pas de « partout » pour les modifications.",
  "write.noPlace":
    "Vous n’avez aucun espace où il pourrait faire des modifications.",
  "kinds.count": "{n, plural, one {# type} other {# types}}",
  "kinds.all": "Les {n} types demandés",
  "kinds.someOn": "{on} sur {n} activés",
  "kinds.label": "Types de fiches",
  "kinds.access": "{kind} : accès",
  "kinds.podWide":
    "{names} : gardés dans tout votre pod, pas dans un espace. Dans les espaces choisis, il ne les atteint que par un rôle dans l’espace, ou s’ils y ont été classés.",
  "reason.prefix": "Sa raison :",
  "dev.toggle": "Détails pour les développeurs",
  "reconsent.title":
    "{n, plural, one {# modification à confirmer} other {# modifications à confirmer}}",
  "reconsent.body":
    "L’accès de {name} demande une vérification rapide : {n, plural, one {un point irait} other {# points iraient}} un peu plus loin. Rien ne change avant votre confirmation.",
  "reconsent.nowWas": "désormais {now} (avant : {was})",
  "reconsent.turnedOff": "désactivé",
  "reconsent.undo": "Rétablir",
  "reconsent.rest": "Tout le reste reste comme vous l’aviez autorisé.",
  "reconsent.new":
    "{n, plural, one {# nouvelle demande} other {# nouvelles demandes}} depuis votre dernière autorisation",
  "reconsent.allowNew": "Autoriser les nouveautés",
  "reconsent.wider": "Plus large",
  "reconsent.narrower": "Plus étroit",
  "reconsent.keepKinds": "S’en tenir aux {n} types",
  "reconsent.turnOffEverywhere": "Désactiver partout : {what}",
  "reconsent.noLonger": "ne vaut plus {where}",
  "reconsent.nowhere": "nulle part",
  "cant.title":
    "{n, plural, one {Il a aussi demandé # chose que vous ne pouvez pas donner} other {Il a aussi demandé # choses que vous ne pouvez pas donner}}",
  "cant.notGiven": "Non accordé",
  "cant.rest":
    "Il se connecte quand même avec le reste. S’il en a besoin, il vous le dira.",
  "cant.ignored": "Les apps ne reçoivent jamais cela.",
  "cant.noWriteSpace":
    "Vous n’avez aucun espace où vous pouvez le laisser faire cette modification.",
  "cant.noReadSpace":
    "Vous n’avez aucun espace où vous pouvez le laisser voir cela.",
  "create.none":
    "Créez un espace dans Synap (ou demandez des droits de modification sur un espace), puis rechargez cette page.",
  "create.offer": "Créez un espace où il peut travailler :",
  "create.from": "Créer un espace à partir de « {name} »",
  "create.proposed":
    "La création de l’espace a été envoyée pour vérification. Approuvez-la, puis rechargez cette page.",
  "create.refused": "Cet espace ne peut pas être créé ici.",
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
  "blocked.noSpace": "Vous n’avez pas encore d’espace à lui donner.",
  "blocked.nothing": "Activez au moins une chose qu’il demande.",
  "blocked.onlyPicked":
    "{names} ne peuvent être donnés que dans les espaces choisis : choisissez des espaces sous Dans, ou activez autre chose.",
  "blocked.writeOrView":
    "Choisissez où il peut faire des modifications, ou réglez {names} sur Voir.",
  "blocked.write": "Choisissez où il peut faire des modifications.",
  "blocked.read":
    "Choisissez au moins un espace ou un projet où il peut travailler.",
  "ask.title":
    "{name} demande {n, plural, one {une chose de plus} other {# choses de plus}}",
  "ask.line": "{what} {where}",
  "ask.stays":
    "Demander plus ne change jamais où il travaille. Pour changer cela, ouvrez",
  "ask.page": "sa page",
  "ask.pickFor": "Choisissez où il peut faire cette modification",
  "ask.newChoice":
    "Il ne modifie rien pour l’instant, c’est donc un nouveau choix.",
  "ask.withinIn": "Seuls les lieux où il peut déjà regarder sont proposés.",
  "ask.blocked": "Choisissez au moins un lieu.",
  "ask.unavailableBlocked":
    "Une partie de cette demande vise un lieu où il ne travaille pas encore : reconnectez-le pour choisir ses lieux.",
  "ask.unavailable":
    "Il a aussi demandé quelque chose qu’aucun de vos espaces ne peut accueillir ; cette partie est laissée de côté.",
  "ask.keeps": "Ce qu’il a déjà reste tel quel.",
  "page.heading": "Accès",
  "page.narrowOnly":
    "Une modification s’applique tout de suite : son accès actuel s’arrête, et le suivant ne contient que ce que vous avez laissé. Vous pouvez retirer des accès ici ; pour en donner plus, il redemande.",
  "page.projectsLocked":
    "Il atteint aussi des projets, que cette page ne peut pas encore modifier. Pour changer son accès, reconnectez-le depuis l’app.",
  "page.saved": "Accès modifié",
  "page.saveFailed": "Impossible de modifier son accès",
  "page.unsaved": "Vous avez des modifications non enregistrées.",
  "page.discard": "Abandonner",
  "page.keepEditing": "Continuer",
  "page.confirmTitle": "Retirer cet accès à {name} ?",
  "page.confirmBody":
    "{name} le perd tout de suite. Son accès actuel s’arrête ; le suivant ne contient que ce qui reste. Pour le lui rendre, il redemande.",
  "page.takeAway": "Retirer",
  "page.revokeInstead": "Pour tout retirer, révoquez-le.",
  "page.confirmLaterTitle": "Un point à confirmer",
  "page.confirmLater":
    "Il continue de fonctionner comme avant. Vous confirmerez la nouvelle forme à votre prochaine connexion.",
};

/** The consent's translator, in the ambient catalog locale. */
export function consentT() {
  return createT(ambientCatalogLocale(), { en, fr });
}
