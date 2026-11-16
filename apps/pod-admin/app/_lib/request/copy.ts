/**
 * The words of one REQUEST as pod admin draws it — its row's chrome, its
 * story's frame (Before · Now · Next), the hand-over and Refuse — as
 * catalogs (`@synap-core/types/i18n`). The story's own lines come from the
 * shared catalog (`needsYouT`, `@synap-core/types/needs-you`) and the ask's
 * from `ASK_COPY`; verbs from the vocabulary door. What an agent or a person
 * wrote (a reason, a purpose, a title) is a param, printed as written. DRAFT
 * French ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  // ── The story's frame ──────────────────────────────────────────────────
  "story.label": "What led here, what you decide, what comes next",
  "story.before": "Before",
  "story.now": "Now",
  "story.after": "Next",
  "story.askedBy": "Asked by",
  "story.forSession": "For",
  "story.foldShow": "Show",
  "story.foldHide": "Hide",
  "story.fullTimeline": "The whole story",
  "story.loading": "Reading what led here…",
  "story.failed": "What led here and what comes next could not be read.",
  "story.retry": "Try again",
  "story.nothingAfter": "Nothing else waits on this.",
  "story.statusMove": "{now} → {next}",
  "story.subject": "What you decide",
  "story.subjectOpen": "Open it",
  "story.needs": "What it needs from you",
  "story.refusing": "If you refuse",
  "story.depth": "More about this request",
  // ── The row ────────────────────────────────────────────────────────────
  "row.openDecision": "Open the decision: {title}",
  "row.select": "Select {title}",
  "row.oneAtATimeAccess": "Access requests are reviewed one at a time",
  "row.oneAtATimeAsk": "Questions are answered one at a time",
  "row.approveOne": "Approve {title}",
  // ── Refuse ─────────────────────────────────────────────────────────────
  "refuse.reasons": "Why",
  "refuse.reason.notNow": "Not now",
  "refuse.reason.notNeeded": "This isn’t needed",
  "refuse.reason.notThisWay": "Ask me another way",
  "refuse.reason.noAccess": "I won’t give this access",
  "refuse.other": "In your words",
  "refuse.cancel": "Keep it open",
  "refuse.confirm": "Refuse it",
  "refuse.proposalConsequence":
    "Nothing it proposes is applied. Whoever asked sees your reason.",
  // ── A secret handed over ───────────────────────────────────────────────
  "secret.for": "For",
  "secret.usedBy": "Used by",
  "secret.on": "On",
  "secret.until": "Until",
  "secret.untilOnce": "One read",
  "secret.untilSession": "This session only",
  "secret.untilStanding": "Until you take it back",
  "secret.usesOnce": "One read only",
  "secret.usesSession": "This session only",
  "secret.used":
    "{n, plural, =0 {Not read yet} one {Read once} other {Read # times}}",
  "secret.lastAt": "last {at}",
  "secret.takeBack": "Take back",
  "secret.takenBack": "Taken back",
  "secret.takeBackFailed": "It could not be taken back",
  "secret.useUnreadable": "What became of this secret could not be read.",
  // ── A proposal that needs an input ─────────────────────────────────────
  "setup.fillFirst": "Fill in {name} first",
  "setup.pickSaved": "One of your saved keys",
  "setup.typeNew": "Type a new key",
  "setup.typeValue": "Type it",
  "setup.newHint":
    "It is saved in your vault first; the request keeps only a pointer to it.",
  "setup.value": "Value",
  "setup.steps": "How to get it",
  "setup.openPage": "Open the page",
  "setup.handOver": "Hand it over",
  "setup.handedOver": "Handed over. It can be approved now.",
  "setup.failed": "It could not be handed over",
  "setup.signInAgain": "Sign in again to type a new key, then try once more.",
  "setup.unreadable": "What it needs could not be read.",
  "setup.retry": "Try again",
} as const;

export const fr: Catalog<typeof en> = {
  "story.label": "Ce qui a mené ici, ce que vous décidez, ce qui suit",
  "story.before": "Avant",
  "story.now": "Maintenant",
  "story.after": "Ensuite",
  "story.askedBy": "Demandé par",
  "story.forSession": "Pour",
  "story.foldShow": "Afficher",
  "story.foldHide": "Masquer",
  "story.fullTimeline": "Toute l’histoire",
  "story.loading": "Lecture de ce qui a mené ici…",
  "story.failed": "Ce qui a mené ici et ce qui suit n’ont pas pu être lus.",
  "story.retry": "Réessayer",
  "story.nothingAfter": "Rien d’autre n’attend ceci.",
  "story.statusMove": "{now} → {next}",
  "story.subject": "Ce que vous décidez",
  "story.subjectOpen": "L’ouvrir",
  "story.needs": "Ce qu’il vous faut fournir",
  "story.refusing": "Si vous refusez",
  "story.depth": "Plus sur cette demande",
  "row.openDecision": "Ouvrir la décision : {title}",
  "row.select": "Sélectionner {title}",
  "row.oneAtATimeAccess": "Les demandes d’accès se décident une par une",
  "row.oneAtATimeAsk": "Les questions se répondent une par une",
  "row.approveOne": "Approuver {title}",
  "refuse.reasons": "Pourquoi",
  "refuse.reason.notNow": "Pas maintenant",
  "refuse.reason.notNeeded": "Ce n’est pas nécessaire",
  "refuse.reason.notThisWay": "Demandez-moi autrement",
  "refuse.reason.noAccess": "Je ne donne pas cet accès",
  "refuse.other": "Avec vos mots",
  "refuse.cancel": "Laisser ouvert",
  "refuse.confirm": "Refuser",
  "refuse.proposalConsequence":
    "Rien de ce qui est proposé n’est appliqué. Le demandeur voit votre raison.",
  "secret.for": "Pour",
  "secret.usedBy": "Utilisé par",
  "secret.on": "Sur",
  "secret.until": "Jusqu’à",
  "secret.untilOnce": "Une seule lecture",
  "secret.untilSession": "Cette session seulement",
  "secret.untilStanding": "Jusqu’à ce que vous le repreniez",
  "secret.usesOnce": "Une seule lecture",
  "secret.usesSession": "Cette session seulement",
  "secret.used":
    "{n, plural, =0 {Pas encore lu} one {Lu une fois} other {Lu # fois}}",
  "secret.lastAt": "dernière fois {at}",
  "secret.takeBack": "Reprendre",
  "secret.takenBack": "Repris",
  "secret.takeBackFailed": "Il n’a pas pu être repris",
  "secret.useUnreadable": "Ce qu’est devenu ce secret n’a pas pu être lu.",
  "setup.fillFirst": "Renseignez d’abord {name}",
  "setup.pickSaved": "Une de vos clés enregistrées",
  "setup.typeNew": "Saisir une nouvelle clé",
  "setup.typeValue": "La saisir",
  "setup.newHint":
    "Elle est d’abord enregistrée dans votre coffre ; la demande n’en garde qu’un pointeur.",
  "setup.value": "Valeur",
  "setup.steps": "Comment l’obtenir",
  "setup.openPage": "Ouvrir la page",
  "setup.handOver": "La fournir",
  "setup.handedOver": "Fournie. La demande peut être approuvée.",
  "setup.failed": "Elle n’a pas pu être fournie",
  "setup.signInAgain":
    "Reconnectez-vous pour saisir une nouvelle clé, puis réessayez.",
  "setup.unreadable": "Ce qu’il faut fournir n’a pas pu être lu.",
  "setup.retry": "Réessayer",
};

export const REQUEST_CATALOGS = { en, fr };
