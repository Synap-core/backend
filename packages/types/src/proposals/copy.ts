/**
 * The words of this folder's sentences, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type, French translates it. DRAFT French,
 * awaiting the founder's review with the vocabulary's (session 1129210f).
 */
import { ambientCatalogLocale } from "../i18n/ambient.js";
import { createT, type Catalog, type Locale } from "../i18n/index.js";

export const en = {
  // A held-writes pack's name counts the writes it holds ("Claude Code,
  // 2026-10-27, 12 items").
  "proposals.heldWrites.items": "{n, plural, one {# item} other {# items}}",
  // WHO IS ASKING (`proposalRequester`): the person an actor acts for, alone
  // (a mark beside the actor) and in the one line.
  "proposals.requester.for": "for {name}",
  "proposals.requester.ownerUnknown": "owner unknown",
  "proposals.requester.forAnother": "for another user",
  "proposals.requester.actorFor": "{actor}, for {name}",
  "proposals.requester.actorOwnerUnknown": "{actor}, owner unknown",
  "proposals.requester.actorForAnother": "{actor}, for another user",
  "proposals.requester.guestThrough": "{guest}, through {form}",
  // HOW IT ENDED (`proposalEndLine`, `./ended.ts`): the line under a withdrawn
  // or expired request's status chip, one per end reason. It never repeats the
  // chip ("Withdrawn"); the doors it names (the newer version, the record, the
  // session, the goal) are drawn beside it by each surface.
  "proposals.ended.superseded": "Replaced by a newer version",
  "proposals.ended.author": "Taken back by {who}",
  "proposals.ended.authorUnnamed": "Taken back by the one who asked for it",
  "proposals.ended.record_landed": "The record already exists",
  "proposals.ended.session_ended": "Its session ended",
  "proposals.ended.goal_ended": "Its goal ended",
  "proposals.ended.lapsed":
    "Nobody decided it in time. Ask again if you still need it.",
  "proposals.ended.lifecycle_move": "A later change made it unnecessary",
  "proposals.ended.agent_attached":
    "The agent it asked for is already on this session",
  "proposals.ended.cleanup_pack": "Cleared by a cleanup you approved",
  "proposals.ended.sent_outside": "The message was sent directly",
  "proposals.ended.request_changed": "No longer asked for",
  "proposals.ended.app_revoked": "The app that asked was revoked",
  // WHO (`proposalWho`, `./ended.ts`): who decided or ended a request, beside
  // its status chip. An expiry names nobody.
  "proposals.who.decided": "Decided by {who}",
  "proposals.who.rule": "Approved by a standing rule",
  "proposals.who.withdrawn": "Withdrawn by {who}",
  "proposals.who.asked": "Asked by {who}",
} as const;

export const fr: Catalog<typeof en> = {
  "proposals.heldWrites.items":
    "{n, plural, one {# élément} many {# d’éléments} other {# éléments}}",
  "proposals.requester.for": "pour {name}",
  "proposals.requester.ownerUnknown": "propriétaire inconnu",
  "proposals.requester.forAnother": "pour un autre utilisateur",
  "proposals.requester.actorFor": "{actor}, pour {name}",
  "proposals.requester.actorOwnerUnknown": "{actor}, propriétaire inconnu",
  "proposals.requester.actorForAnother": "{actor}, pour un autre utilisateur",
  "proposals.requester.guestThrough": "{guest}, via {form}",
  // A participle agrees with the status chip beside it, which is masculine
  // ("Retiré", "Expiré": vocabulary D4).
  "proposals.ended.superseded": "Remplacé par une version plus récente",
  "proposals.ended.author": "Repris par {who}",
  "proposals.ended.authorUnnamed": "Repris par son demandeur",
  "proposals.ended.record_landed": "L’élément existe déjà",
  "proposals.ended.session_ended": "Sa session est terminée",
  "proposals.ended.goal_ended": "Son objectif est terminé",
  "proposals.ended.lapsed":
    "Personne ne l’a décidé à temps. Redemandez-le si vous en avez encore besoin.",
  "proposals.ended.lifecycle_move": "Un changement ultérieur l’a rendu inutile",
  "proposals.ended.agent_attached":
    "L’agent demandé travaille déjà sur cette session",
  "proposals.ended.cleanup_pack":
    "Retiré par un nettoyage que vous avez approuvé",
  "proposals.ended.sent_outside": "Le message a été envoyé directement",
  "proposals.ended.request_changed": "N’est plus demandé",
  "proposals.ended.app_revoked": "L’application qui le demandait a été révoquée",
  "proposals.who.decided": "Décidé par {who}",
  "proposals.who.rule": "Approuvé par une règle permanente",
  "proposals.who.withdrawn": "Retiré par {who}",
  "proposals.who.asked": "Demandé par {who}",
};

export const proposalsCopy = { en, fr } as const;

/** This folder's translator, in `locale` (else the ambient catalog locale). */
export function proposalsT(locale?: Locale) {
  return createT(locale ?? ambientCatalogLocale(), proposalsCopy);
}
