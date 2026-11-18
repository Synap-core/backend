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
  // or expired request's status chip, one per end reason.
  "proposals.ended.superseded": "Replaced by a newer version",
  "proposals.ended.author": "Withdrawn by whoever asked for it",
  "proposals.ended.record_landed": "The record already exists",
  "proposals.ended.session_ended": "Its job ended",
  "proposals.ended.goal_ended": "Its goal ended",
  "proposals.ended.lapsed": "Its moment passed",
  "proposals.ended.lifecycle_move": "A later change made it unnecessary",
  "proposals.ended.agent_attached": "The agent is already on the job",
  "proposals.ended.cleanup_pack": "Cleared by a cleanup you approved",
  "proposals.ended.sent_outside": "The message was sent directly",
  "proposals.ended.request_changed": "No longer asked for",
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
  "proposals.ended.superseded": "Remplacée par une version plus récente",
  "proposals.ended.author": "Retirée par son demandeur",
  "proposals.ended.record_landed": "L’élément existe déjà",
  "proposals.ended.session_ended": "Son travail est terminé",
  "proposals.ended.goal_ended": "Son objectif est terminé",
  "proposals.ended.lapsed": "Elle n’est plus d’actualité",
  "proposals.ended.lifecycle_move":
    "Un changement ultérieur l’a rendue inutile",
  "proposals.ended.agent_attached": "L’agent est déjà sur ce travail",
  "proposals.ended.cleanup_pack":
    "Retirée par un nettoyage que vous avez approuvé",
  "proposals.ended.sent_outside": "Le message a été envoyé directement",
  "proposals.ended.request_changed": "N’est plus demandée",
};

export const proposalsCopy = { en, fr } as const;

/** This folder's translator, in `locale` (else the ambient catalog locale). */
export function proposalsT(locale?: Locale) {
  return createT(locale ?? ambientCatalogLocale(), proposalsCopy);
}
