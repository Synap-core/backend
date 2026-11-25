/**
 * The ASK CARD's words (`ASK_COPY`, `./card.ts`), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type, French
 * translates it. DRAFT French ("vous"), awaiting the founder's review with
 * the vocabulary's. What an agent or a person wrote (a label, a quote, a
 * reason, a service or space name) is a param, printed as written.
 *
 * `{job}` and `{step}` are the vocabulary's nouns for a session and a stage
 * in the same locale (`resolveObjectNoun`), lower-cased for a sentence. The
 * French articles agree with today's nouns ("le travail", "la prochaine
 * étape"): a new French noun re-reads these four messages.
 */
import { ambientCatalogLocale } from "../i18n/ambient.js";
import { createT, type Catalog, type Locale } from "../i18n/index.js";

export const en = {
  "ask.yes": "Yes",
  "ask.no": "No",
  "ask.didThis": "I did this",
  "ask.notMine": "Not mine",
  "ask.notMineReceipt": "Not mine: {label}",
  "ask.refuseReason": "Tell the agent why (optional)",
  "ask.refuseConsequence":
    "The agent gets this back with your reason and picks its next step. Nothing is handed over.",
  "ask.talk": "Talk it through",
  "ask.answerDoor": "Answer…",
  "ask.movedOn": "This one moved on",
  "ask.askChanged": "The question changed. Check your answer.",
  "ask.failedTitle": "Didn't go through",
  "ask.doneByYou": "Done by you",
  "ask.youAnswered": "You answered: {answer}",
  "ask.agentHasIt": "The agent has it back.",
  "ask.lookedAt": "What I looked at",
  "ask.whyHeading": "Why",
  "ask.followedAiPick": "Followed AI pick",
  "ask.choseDifferently": "Chose differently from AI",
  "ask.aiPicked": "AI picked: {label}",
  "ask.neededBy": "Needed by {when}",
  "ask.neededIn": "Needed in {span}",
  "ask.overdueBy": "Overdue by {span}",
  "ask.provideTitle": "Not answerable here yet",
  "ask.provideBody": "Talk it through with the agent.",
  "ask.provideConnect": "Connect {service}",
  "ask.provideUseExisting": "Use an account you already connected",
  "ask.provideWhichAccount": "Which account?",
  "ask.provideConnectUnavailable":
    "{reason, select, no_broker {This pod can't connect accounts yet. A pod admin sets that up.} not_offered {This pod does not offer a {service} connection yet. A pod admin can add it.} other {Couldn't check which connections this pod offers. Try again in a moment.}}",
  "ask.provideAccountShared": "Shared with the pod",
  "ask.provideAccountNeedsSignIn": "Needs signing in again",
  "ask.provideWaitingForConnection":
    "Finish connecting {service}. This answers itself when it is done.",
  "ask.provideUpload": "Upload a file",
  "ask.provideLandsIn": "It will be saved in {space}.",
  "ask.providePickSecret": "Pick a secret from your vault",
  "ask.provideAddSecret": "Add the secret",
  "ask.provideAddSecretInApp":
    "New secrets are added in the Synap app, never typed here.",
  // The cap said as a cap, "up to" (review S11), as the option says it. The
  // noun is the vocabulary's ({job}): the card face never says "session"
  // (founder G1, `card-words.test.ts`).
  "ask.provideGrantNote":
    "{agent} can read it for up to {minutes, plural, one {# minute} other {# minutes}}, in this {job} only.",
  "ask.provideGrantOnceNote":
    "{agent} can read it once, within {minutes, plural, one {# minute} other {# minutes}}, in this {job} only.",
  "ask.provideStandingGrantNote":
    "{agent} can already read this secret, until you take it back. Nothing new is granted.",
  "ask.provideNoPurpose": "The agent did not say what it is for.",
  "ask.provideNoGrantNote":
    "No agent will be able to read it yet. The agent has to ask for access.",
  "ask.provideAgentChangedTitle": "No agent can read your secret yet",
  "ask.provideAgentChangedBody":
    "The agent working on this changed. Reopen it to see who gets access.",
  "ask.provideUploadKept":
    "The file was saved in {space}, but it wasn't handed over.",
  "ask.draftStarted":
    "{named, select, yes {{agent} started {work}} other {An agent started {work}}}",
  "ask.answeredByYou": "You answered",
  "ask.relayedBy":
    "{named, select, yes {Answered in chat · relayed by {agent}} other {Answered in chat · relayed}}",
  "ask.relayConfirmed":
    "{named, select, yes {You confirmed what {agent} relayed} other {You confirmed the relayed answer}}",
  "ask.awaitingYourTap":
    "{named, select, yes {Relayed by {agent} · needs your tap} other {Relayed · needs your tap}}",
  "ask.confirmRelayed": "Confirm",
  "ask.notWhatISaid": "Not what I said",
  "ask.youSaid": "You said “{quote}”",
  "ask.relayConfirmedReceipt": "Confirmed · {heading}",
  "ask.relayRejectedReceipt": "Not recorded · the question is yours again",
  "ask.withdrawn":
    "{noted, select, yes {Withdrawn · {note}} other {Withdrawn}}",
  "ask.closedSessionEnded": "Closed · the {job} ended",
  // Someone's words, quoted (`relayedWords`).
  "ask.quoted": "“{words}”",
  "ask.askedAgo": "Asked {span} ago",
  "ask.addNote": "Add a note",
  "ask.note": "Note",
  "ask.recommended": "Recommended",
  // What raised an ask no agent asked (`askCause`), and its date.
  "ask.cause.decision": "From a proposed decision",
  "ask.cause.gate": "Before the {job}'s next {step}",
  "ask.cause.run": "From the run",
  "ask.cause.external_approval": "From the external agent's run",
  "ask.cause.param": "From the playbook's inputs",
  "ask.cause.criterion": "From the {job}'s checks",
  // A cause kind a newer pod sends: the ask still lives in a session.
  "ask.cause.unknown": "From the {job}",
  "ask.cause.withDate": "{cause} · {at}",
} as const;

export const fr: Catalog<typeof en> = {
  "ask.yes": "Oui",
  "ask.no": "Non",
  "ask.didThis": "Je l’ai fait",
  "ask.notMine": "Pas pour moi",
  "ask.notMineReceipt": "Pas pour moi : {label}",
  "ask.refuseReason": "Dites à l’agent pourquoi (facultatif)",
  "ask.refuseConsequence":
    "L’agent reçoit votre refus avec votre raison et choisit la suite. Rien n’est transmis.",
  "ask.talk": "En discuter",
  "ask.answerDoor": "Répondre…",
  "ask.movedOn": "Cette demande a avancé",
  "ask.askChanged": "La question a changé. Vérifiez votre réponse.",
  "ask.failedTitle": "Cela n’a pas abouti",
  "ask.doneByYou": "Fait par vous",
  "ask.youAnswered": "Vous avez répondu : {answer}",
  "ask.agentHasIt": "L’agent a repris la main.",
  "ask.lookedAt": "Ce que j’ai consulté",
  "ask.whyHeading": "Pourquoi",
  "ask.followedAiPick": "Choix de l’IA suivi",
  "ask.choseDifferently": "Choix différent de l’IA",
  "ask.aiPicked": "Choix de l’IA : {label}",
  "ask.neededBy": "Attendu pour {when}",
  "ask.neededIn": "Attendu dans {span}",
  "ask.overdueBy": "En retard de {span}",
  "ask.provideTitle": "Pas encore possible de répondre ici",
  "ask.provideBody": "Voyez-le avec l’agent.",
  "ask.provideConnect": "Connecter {service}",
  "ask.provideUseExisting": "Utiliser un compte déjà connecté",
  "ask.provideWhichAccount": "Quel compte ?",
  "ask.provideConnectUnavailable":
    "{reason, select, no_broker {Ce pod ne peut pas encore connecter de comptes. Un administrateur du pod s’en charge.} not_offered {Ce pod ne propose pas encore de connexion {service}. Un administrateur du pod peut l’ajouter.} other {Impossible de vérifier les connexions que ce pod propose. Réessayez dans un instant.}}",
  "ask.provideAccountShared": "Partagé avec le pod",
  "ask.provideAccountNeedsSignIn": "Reconnexion nécessaire",
  "ask.provideWaitingForConnection":
    "Terminez la connexion à {service}. La réponse se fait d’elle-même une fois terminée.",
  "ask.provideUpload": "Envoyer un fichier",
  "ask.provideLandsIn": "Il sera enregistré dans {space}.",
  "ask.providePickSecret": "Choisissez un secret dans votre coffre",
  "ask.provideAddSecret": "Ajouter le secret",
  "ask.provideAddSecretInApp":
    "Les nouveaux secrets s’ajoutent dans l’app Synap, jamais saisis ici.",
  "ask.provideGrantNote":
    "{agent} peut le lire jusqu’à {minutes, plural, one {# minute} other {# minutes}}, dans ce {job} seulement.",
  "ask.provideGrantOnceNote":
    "{agent} peut le lire une fois, dans les {minutes, plural, one {# minute} other {# minutes}}, dans ce {job} seulement.",
  "ask.provideStandingGrantNote":
    "{agent} peut déjà lire ce secret, jusqu’à ce que vous le repreniez. Rien de nouveau n’est accordé.",
  "ask.provideNoPurpose": "L’agent n’a pas dit à quoi il sert.",
  "ask.provideNoGrantNote":
    "Aucun agent ne pourra le lire pour l’instant. L’agent doit demander l’accès.",
  "ask.provideAgentChangedTitle":
    "Aucun agent ne peut encore lire votre secret",
  "ask.provideAgentChangedBody":
    "L’agent qui travaille sur ceci a changé. Rouvrez-le pour voir qui y a accès.",
  "ask.provideUploadKept":
    "Le fichier a été enregistré dans {space}, mais il n’a pas été transmis.",
  "ask.draftStarted":
    "{named, select, yes {{agent} a commencé {work}} other {Un agent a commencé {work}}}",
  "ask.answeredByYou": "Vous avez répondu",
  "ask.relayedBy":
    "{named, select, yes {Répondu dans le chat · relayé par {agent}} other {Répondu dans le chat · relayé}}",
  "ask.relayConfirmed":
    "{named, select, yes {Vous avez confirmé ce que {agent} a relayé} other {Vous avez confirmé la réponse relayée}}",
  "ask.awaitingYourTap":
    "{named, select, yes {Relayé par {agent} · attend votre confirmation} other {Relayé · attend votre confirmation}}",
  "ask.confirmRelayed": "Confirmer",
  "ask.notWhatISaid": "Ce n’est pas ce que j’ai dit",
  "ask.youSaid": "Vous avez dit « {quote} »",
  "ask.relayConfirmedReceipt": "Confirmé · {heading}",
  "ask.relayRejectedReceipt": "Non enregistré · la question vous revient",
  "ask.withdrawn": "{noted, select, yes {Retirée · {note}} other {Retirée}}",
  "ask.closedSessionEnded": "Close · le {job} est terminé",
  "ask.quoted": "« {words} »",
  "ask.askedAgo": "Demandé il y a {span}",
  "ask.addNote": "Ajouter une note",
  "ask.note": "Note",
  "ask.recommended": "Recommandé",
  "ask.cause.decision": "D’une décision proposée",
  "ask.cause.gate": "Avant la prochaine {step} du {job}",
  "ask.cause.run": "De l’exécution",
  "ask.cause.external_approval": "De l’exécution de l’agent externe",
  "ask.cause.param": "Des entrées du playbook",
  "ask.cause.criterion": "Des vérifications du {job}",
  "ask.cause.unknown": "Du {job}",
  "ask.cause.withDate": "{cause} · {at}",
};

export const askCopyCatalogs = { en, fr } as const;

/** This folder's translator, in `locale` (else the ambient catalog locale). */
export function askT(locale?: Locale) {
  return createT(locale ?? ambientCatalogLocale(), askCopyCatalogs);
}
