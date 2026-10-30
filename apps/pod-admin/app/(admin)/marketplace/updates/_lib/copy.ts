/**
 * Template updates' words (Marketplace › Updates, the Review page, the
 * package page's installed states), as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. The words of a field's state are not
 * here: they come from the one derivation shared with the CLI and Relay
 * (`packageFieldStateLabel`, `contract.ts`). DRAFT French ("vous"), awaiting
 * the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "tab.updates": "Updates",
  "list.loading": "Loading updates",
  "list.failed": "Couldn’t check your installed packages against the catalog.",
  "list.current":
    "Everything you installed matches the catalog. Checked {when}.",
  "list.currentCount":
    "{n, plural, one {# package already matches the catalog: {names}.} other {# packages already match the catalog: {names}.}}",
  "list.applyNothing":
    "{n, plural, one {Apply # update that needs nothing from you} other {Apply # updates that need nothing from you}}",
  "list.applying": "Applying {done} of {n}…",
  "list.applied":
    "{n, plural, one {# update applied.} other {# updates applied.}}",
  "list.appliedSome": "{done} of {n} applied. {failed} could not apply.",
  "list.proposedSome":
    "{n, plural, one {# update went for approval.} other {# updates went for approval.}}",
  "group.choice.meta": "You edited what the catalog changed",
  "group.consent.meta": "The update changes existing records",
  "group.review.meta": "Nobody edited what changed",
  "group.nothing.meta": "You edited it; the catalog has not changed it",
  "group.unreadable": "Can’t check",
  "group.unreadable.meta": "The pod could not read these packages’ catalog",
  "mark.choice": "Your edit and a catalog change",
  "mark.consent": "Changes your records",
  "mark.review": "Ready",
  "mark.nothing": "Yours",
  "mark.unreadable": "Can’t check",
  "mark.current": "Up to date",
  "count.both": "{n, plural, one {# to choose} other {# to choose}}",
  "count.updates":
    "{n, plural, one {# field updates on its own} other {# fields update on their own}}",
  "count.yours": "{n, plural, one {# stays yours} other {# stay yours}}",
  "count.same": "{n, plural, one {# the same} other {# the same}}",
  "count.data":
    "{n, plural, one {# change to your records} other {# changes to your records}}",
  "row.secondary": "{kind} · {counts}",
  "review.loading": "Loading the update",
  "review.failed": "Couldn’t read this update from the pod.",
  "review.retry": "Try again",
  "review.gone.title": "No update waits for this package",
  "review.gone.body":
    "It is not installed on this pod, or it already matches the catalog.",
  "review.gone.back": "See all updates",
  "review.conflict":
    "The catalog changed this package again since you opened the page. Nothing was written.",
  "review.conflict.reload": "Reload the update",
  "review.trail": "Updates",
  "review.summary.choose":
    "The catalog changed this {kind}, and it was also edited on your pod. Choose what to keep.",
  "review.summary.consent":
    "This update changes records on your pod. Read what it does, then give your OK.",
  "review.summary.auto":
    "The catalog changed this {kind}; nobody edited what changed, so it can update on its own.",
  "review.summary.yours":
    "You edited this {kind}; the catalog has not changed what you edited.",
  "review.version": "Version",
  "review.queue": "{index} of {total}",
  "review.previous": "Previous update",
  "review.next": "Next update",
  "review.sameRest":
    "{n, plural, one {# other field is the same in the catalog and here.} other {# other fields are the same in the catalog and here.}}",
  "lane.base": "Catalog when you installed",
  "lane.desired": "Catalog now",
  "lane.live": "Yours",
  "lane.empty": "Empty",
  "lane.chars": "{n, plural, one {# character} other {# characters}}",
  "tab.catalog": "What the catalog changed",
  "tab.yours": "What you changed",
  "tab.side": "Side by side",
  "tab.result": "Result",
  "tabs.aria": "Read this field as",
  "reading.same": "No difference here.",
  "field.updates": "Updates to the catalog’s value on its own.",
  "field.yours": "Stays as you wrote it: the catalog did not change it.",
  "choice.question": "What should {field} be?",
  "choice.recommended": "Recommended",
  "choice.catalog": "Take the catalog’s",
  "choice.combine": "Combine both",
  "choice.mine": "Keep mine",
  "choice.edit": "Edit the result",
  "choice.catalog.hint": "The catalog’s text replaces yours.",
  "choice.catalog.hintOverlap": "Your change is already in it, word for word.",
  "choice.combine.hint": "Both changes, together.",
  "choice.combine.conflict": "Not offered: both changed the same lines.",
  "choice.combine.notText": "Not offered for this kind of field.",
  "choice.combine.sameAsCatalog":
    "Same result as the catalog’s here: your change is in it.",
  "choice.combine.sameAsMine":
    "Same result as yours here: the catalog’s change is in it.",
  "choice.mine.hint": "Stay on your text, without the catalog’s change.",
  "choice.edit.hint": "Start from both, write it yourself.",
  "consequence.catalog":
    "{field} becomes the catalog’s. Future catalog changes reach it on their own again, until someone edits it.",
  "consequence.catalogOverlap":
    "{field} becomes the catalog’s. You lose nothing: your change is in it.",
  "consequence.combine":
    "{field} keeps your change and gains the catalog’s. Synap compares the next catalog change with the catalog’s new value.",
  "consequence.mine":
    "Your {field} stays. The catalog’s change does not reach it, and Synap asks again only when the catalog changes it again.",
  "consequence.edit":
    "You write {field}. What you save becomes yours, and Synap compares the next catalog change with the catalog’s new value.",
  "edit.label": "{field}, as it will read",
  "records.title": "Changes to your records",
  "records.meta": "Runs once, when you apply",
  "records.destructive": "An operator step: an update never runs it.",
  "records.affected": "{n, plural, one {# record} other {# records}}",
  "records.note":
    "Nothing is deleted; the old values stay in each record’s history.",
  "why.title": "What the catalog changed",
  "why.version": "Installed {from} · catalog now {to}",
  "after.title": "What applying does",
  "after.write":
    "Writes what you chose, as you, through the {kind}’s usual edit door. Recorded in History.",
  "after.baseline":
    "Records the catalog’s version as the new starting point: the update leaves the list, and the next catalog change is compared with it.",
  "after.undo": "Keeps what it replaced: Undo puts it back for 30 days.",
  "after.agents":
    "Agents get the new version the next time they load it; a run already going keeps what it loaded.",
  "bar.update":
    "{changing, plural, one {# field changes} other {# fields change}}",
  "bar.keep":
    "{keeping, plural, one {# field stays yours} other {# fields stay yours}}",
  "bar.nothing": "Nothing is written; this update leaves the list.",
  "bar.missing":
    "{n, plural, one {Choose what to keep for {fields} first.} other {Choose what to keep for # fields first: {fields}.}}",
  "bar.keepMine": "Keep mine",
  "bar.withoutRecords":
    "{n, plural, one {Runs without # change to your records} other {Runs without # changes to your records}}",
  "bar.primary": "Update {kind}",
  "bar.notNow": "Not now",
  "bar.stop": "Stop updates",
  "bar.version": "The catalog named no version: reload the update.",
  "bar.applying": "Applying…",
  "stop.title": "Stop updates for {name}?",
  "stop.body":
    "It becomes fully yours: the catalog never changes it again, and it leaves this list. You can install the catalog’s version again later.",
  "stop.confirm": "Stop updates",
  "stop.done": "Updates stopped. {name} is fully yours now.",
  "stop.failed": "Couldn’t stop updates. Nothing changed.",
  "apply.failed": "The update didn’t apply. Nothing was written.",
  "receipt.applied": "Updated. {name} follows the catalog’s version {version}.",
  "receipt.changed": "Changed: {fields}. What it replaced is kept for 30 days.",
  "receipt.nothing": "Your choice is recorded; nothing on the pod changed.",
  "receipt.proposed":
    "Sent for approval. It applies once someone with access approves it.",
  "receipt.openRequest": "Open the request",
  "receipt.next": "Next update",
  "receipt.all": "Back to updates",
  "receipt.undo": "Undo update",
  "receipt.undoing": "Undoing…",
  "receipt.undone": "Undone. {name} is back to what it was.",
  "receipt.undoFailed": "Couldn’t undo the update. Nothing changed.",
  "receipt.undoChanged":
    "Couldn’t undo: a field it changed was edited again since. Nothing changed.",
  "receipt.undoExpired": "Couldn’t undo: the 30 days to undo it are over.",
  "installed.update": "Review update",
  "installed.compare": "Compare with the catalog",
  "installed.stop": "Stop updates for this {kind}",
  "installed.stop.hint":
    "It becomes fully yours; the catalog never changes it again",
  "installed.title": "Your installed copy",
  "installed.failed": "Couldn’t compare your installed copy with the catalog.",
  "installed.current": "Matches the catalog.",
  "installed.promise":
    "When the catalog changes it, what nobody edited follows on its own and what you edit waits for your choice in Updates.",
} as const;

export const fr: Catalog<typeof en> = {
  "tab.updates": "Mises à jour",
  "list.loading": "Chargement des mises à jour",
  "list.failed":
    "Impossible de comparer vos paquets installés avec le catalogue.",
  "list.current":
    "Tout ce que vous avez installé correspond au catalogue. Vérifié {when}.",
  "list.currentCount":
    "{n, plural, one {# paquet correspond déjà au catalogue : {names}.} other {# paquets correspondent déjà au catalogue : {names}.}}",
  "list.applyNothing":
    "{n, plural, one {Appliquer # mise à jour qui ne demande rien} other {Appliquer # mises à jour qui ne demandent rien}}",
  "list.applying": "Application {done} sur {n}…",
  "list.applied":
    "{n, plural, one {# mise à jour appliquée.} other {# mises à jour appliquées.}}",
  "list.appliedSome":
    "{done} sur {n} appliquées. {failed} n’ont pas pu s’appliquer.",
  "list.proposedSome":
    "{n, plural, one {# mise à jour envoyée pour approbation.} other {# mises à jour envoyées pour approbation.}}",
  "group.choice.meta": "Vous avez modifié ce que le catalogue a changé",
  "group.consent.meta": "La mise à jour modifie des fiches existantes",
  "group.review.meta": "Personne n’a modifié ce qui a changé",
  "group.nothing.meta": "Vous l’avez modifié ; le catalogue ne l’a pas changé",
  "group.unreadable": "Vérification impossible",
  "group.unreadable.meta": "Le pod n’a pas pu lire le catalogue de ces paquets",
  "mark.choice": "Votre modification et celle du catalogue",
  "mark.consent": "Modifie vos fiches",
  "mark.review": "Prête",
  "mark.nothing": "À vous",
  "mark.unreadable": "Vérification impossible",
  "mark.current": "À jour",
  "count.both": "{n, plural, one {# à choisir} other {# à choisir}}",
  "count.updates":
    "{n, plural, one {# champ se met à jour seul} other {# champs se mettent à jour seuls}}",
  "count.yours": "{n, plural, one {# reste à vous} other {# restent à vous}}",
  "count.same": "{n, plural, one {# identique} other {# identiques}}",
  "count.data":
    "{n, plural, one {# changement sur vos fiches} other {# changements sur vos fiches}}",
  "row.secondary": "{kind} · {counts}",
  "review.loading": "Chargement de la mise à jour",
  "review.failed": "Impossible de lire cette mise à jour sur le pod.",
  "review.retry": "Réessayer",
  "review.gone.title": "Aucune mise à jour n’attend pour ce paquet",
  "review.gone.body":
    "Il n’est pas installé sur ce pod, ou il correspond déjà au catalogue.",
  "review.gone.back": "Voir toutes les mises à jour",
  "review.conflict":
    "Le catalogue a encore changé ce paquet depuis l’ouverture de la page. Rien n’a été écrit.",
  "review.conflict.reload": "Recharger la mise à jour",
  "review.trail": "Mises à jour",
  "review.summary.choose":
    "Le catalogue a changé cet élément ({kind}), et il a aussi été modifié sur votre pod. Choisissez ce que vous gardez.",
  "review.summary.consent":
    "Cette mise à jour modifie des fiches sur votre pod. Lisez ce qu’elle fait, puis donnez votre accord.",
  "review.summary.auto":
    "Le catalogue a changé cet élément ({kind}) ; personne n’a modifié ce qui a changé, il peut donc se mettre à jour seul.",
  "review.summary.yours":
    "Vous avez modifié cet élément ({kind}) ; le catalogue n’a pas changé ce que vous avez modifié.",
  "review.version": "Version",
  "review.queue": "{index} sur {total}",
  "review.previous": "Mise à jour précédente",
  "review.next": "Mise à jour suivante",
  "review.sameRest":
    "{n, plural, one {# autre champ est identique dans le catalogue et ici.} other {# autres champs sont identiques dans le catalogue et ici.}}",
  "lane.base": "Catalogue à l’installation",
  "lane.desired": "Catalogue actuel",
  "lane.live": "Le vôtre",
  "lane.empty": "Vide",
  "lane.chars": "{n, plural, one {# caractère} other {# caractères}}",
  "tab.catalog": "Ce que le catalogue a changé",
  "tab.yours": "Ce que vous avez changé",
  "tab.side": "Côte à côte",
  "tab.result": "Résultat",
  "tabs.aria": "Lire ce champ comme",
  "reading.same": "Aucune différence ici.",
  "field.updates": "Prend seul la valeur du catalogue.",
  "field.yours":
    "Reste tel que vous l’avez écrit : le catalogue ne l’a pas changé.",
  "choice.question": "Que doit devenir {field} ?",
  "choice.recommended": "Recommandé",
  "choice.catalog": "Prendre celui du catalogue",
  "choice.combine": "Combiner les deux",
  "choice.mine": "Garder le mien",
  "choice.edit": "Modifier le résultat",
  "choice.catalog.hint": "Le texte du catalogue remplace le vôtre.",
  "choice.catalog.hintOverlap": "Votre modification y est déjà, mot pour mot.",
  "choice.combine.hint": "Les deux modifications, ensemble.",
  "choice.combine.notText": "Non proposé pour ce type de champ.",
  "choice.combine.conflict":
    "Non proposé : les deux ont changé les mêmes lignes.",
  "choice.combine.sameAsCatalog":
    "Même résultat que celui du catalogue ici : votre modification y est.",
  "choice.combine.sameAsMine":
    "Même résultat que le vôtre ici : la modification du catalogue y est.",
  "choice.mine.hint":
    "Rester sur votre texte, sans la modification du catalogue.",
  "choice.edit.hint": "Partir des deux, l’écrire vous-même.",
  "consequence.catalog":
    "{field} prend la valeur du catalogue. Les prochains changements du catalogue s’y appliquent seuls, jusqu’à ce que quelqu’un le modifie.",
  "consequence.catalogOverlap":
    "{field} prend la valeur du catalogue. Vous ne perdez rien : votre modification y est.",
  "consequence.combine":
    "{field} garde votre modification et reçoit celle du catalogue. Synap compare le prochain changement du catalogue avec sa nouvelle valeur.",
  "consequence.mine":
    "Votre version de {field} reste. Le changement du catalogue ne s’y applique pas, et Synap redemande seulement quand le catalogue le change à nouveau.",
  "consequence.edit":
    "Vous écrivez {field}. Ce que vous enregistrez devient le vôtre, et Synap compare le prochain changement du catalogue avec sa nouvelle valeur.",
  "edit.label": "{field}, tel qu’il se lira",
  "records.title": "Changements sur vos fiches",
  "records.meta": "S’exécute une fois, quand vous appliquez",
  "records.destructive":
    "Une étape d’opérateur : une mise à jour ne l’exécute jamais.",
  "records.affected": "{n, plural, one {# fiche} other {# fiches}}",
  "records.note":
    "Rien n’est supprimé ; les anciennes valeurs restent dans l’historique de chaque fiche.",
  "why.title": "Ce que le catalogue a changé",
  "why.version": "Installé {from} · catalogue actuel {to}",
  "after.title": "Ce que fait l’application",
  "after.write":
    "Écrit ce que vous avez choisi, en votre nom, par la porte de modification habituelle ({kind}). Enregistré dans l’historique.",
  "after.baseline":
    "Enregistre la version du catalogue comme nouveau point de départ : la mise à jour quitte la liste, et le prochain changement du catalogue est comparé à elle.",
  "after.undo":
    "Garde ce qu’elle remplace : Annuler le remet en place pendant 30 jours.",
  "after.agents":
    "Les agents reçoivent la nouvelle version au prochain chargement ; une exécution en cours garde ce qu’elle a chargé.",
  "bar.update":
    "{changing, plural, one {# champ change} other {# champs changent}}",
  "bar.keep":
    "{keeping, plural, one {# champ reste à vous} other {# champs restent à vous}}",
  "bar.nothing": "Rien n’est écrit ; cette mise à jour quitte la liste.",
  "bar.missing":
    "{n, plural, one {Choisissez d’abord ce que vous gardez pour {fields}.} other {Choisissez d’abord ce que vous gardez pour # champs : {fields}.}}",
  "bar.keepMine": "Garder le mien",
  "bar.withoutRecords":
    "{n, plural, one {S’exécute sans # changement sur vos fiches} other {S’exécute sans # changements sur vos fiches}}",
  "bar.primary": "Mettre à jour : {kind}",
  "bar.notNow": "Pas maintenant",
  "bar.stop": "Arrêter les mises à jour",
  "bar.version":
    "Le catalogue n’a pas donné de version : rechargez la mise à jour.",
  "bar.applying": "Application…",
  "stop.title": "Arrêter les mises à jour de {name} ?",
  "stop.body":
    "Il devient entièrement le vôtre : le catalogue ne le change plus jamais, et il quitte cette liste. Vous pourrez réinstaller la version du catalogue plus tard.",
  "stop.confirm": "Arrêter les mises à jour",
  "stop.done": "Mises à jour arrêtées. {name} est entièrement à vous.",
  "stop.failed": "Impossible d’arrêter les mises à jour. Rien n’a changé.",
  "apply.failed": "La mise à jour ne s’est pas appliquée. Rien n’a été écrit.",
  "receipt.applied":
    "Mis à jour. {name} suit la version {version} du catalogue.",
  "receipt.changed":
    "Modifié : {fields}. Ce qui a été remplacé est gardé 30 jours.",
  "receipt.nothing": "Votre choix est enregistré ; rien n’a changé sur le pod.",
  "receipt.proposed":
    "Envoyée pour approbation. Elle s’applique dès qu’une personne autorisée l’approuve.",
  "receipt.openRequest": "Ouvrir la demande",
  "receipt.next": "Mise à jour suivante",
  "receipt.all": "Retour aux mises à jour",
  "receipt.undo": "Annuler la mise à jour",
  "receipt.undoing": "Annulation…",
  "receipt.undone": "Annulé. {name} est revenu à ce qu’il était.",
  "receipt.undoChanged":
    "Annulation impossible : un champ modifié a été changé depuis. Rien n’a changé.",
  "receipt.undoExpired":
    "Annulation impossible : les 30 jours pour l’annuler sont passés.",
  "receipt.undoFailed": "Impossible d’annuler la mise à jour. Rien n’a changé.",
  "installed.update": "Voir la mise à jour",
  "installed.compare": "Comparer avec le catalogue",
  "installed.stop": "Arrêter les mises à jour ({kind})",
  "installed.stop.hint":
    "Il devient entièrement le vôtre ; le catalogue ne le change plus jamais",
  "installed.title": "Votre copie installée",
  "installed.failed":
    "Impossible de comparer votre copie installée avec le catalogue.",
  "installed.current": "Correspond au catalogue.",
  "installed.promise":
    "Quand le catalogue le change, ce que personne n’a modifié suit seul, et ce que vous modifiez attend votre choix dans Mises à jour.",
};
