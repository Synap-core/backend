/**
 * The words of the review detail's GRANT requests (an agent asking to
 * connect, an outside identity issuer, an app's origin): the five trust
 * signals, why it needs approval, the decide bar and each body, as catalogs
 * (`@synap-core/types/i18n`). The refuse verb is the vocabulary's
 * (`resolveActionLabel("refuse")`), the same one asks and proposals say.
 * What a requester wrote or the pod resolved (a name, a URL, an origin, a
 * space) is a param, printed as written. `{mark}` is where the surface draws
 * that name in its own type (bold, mono): a mark, never a word. DRAFT French
 * ("vous"), awaiting the founder's review.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  // ── The five trust signals ─────────────────────────────────────────────
  "trust.who": "Who is asking",
  "trust.what": "What it will be able to do",
  "trust.where": "Where",
  "trust.approver": "Who approves",
  "trust.approverNamed":
    "You are signed in as {mark}. Your decision is recorded in the Audit log.",
  "trust.approverYou": "You. Your decision is recorded in the Audit log.",
  "trust.when": "When and from where",
  "where.pod": "Your pod, {scope}",
  "where.podHost": "Your pod {mark}, {scope}",
  "where.space": "{space} space only.",
  "where.everywhere": "across the pod.",
  "approval.lead": "Why this needs approval.",
  // ── The decide bar ─────────────────────────────────────────────────────
  "decide.refuse": "{verb}…",
  "decide.reason": "Reason",
  "decide.reasonHint":
    "The requester sees this, so say what would change your mind.",
  "decide.confirmRefuse": "Refuse and tell them",
  "decide.cancel": "Keep it open",
  "decide.alreadyDecided": "Already decided",
  "decide.failed": "Action couldn’t be completed",
  // ── An agent asking to connect ─────────────────────────────────────────
  "agent.who": "An agent named {mark}.",
  "agent.whoBy": "An agent named {mark}, connected by {requester}.",
  "agent.unnamed": "this agent",
  "agent.what":
    "Everything listed below, and nothing else. Its writes still follow your review rules.",
  "agent.when": "{at} ({ago}).",
  "agent.whenFrom": "{at} ({ago}), from {from}.",
  "agent.needsApproval": "New agents need a person to approve their access.",
  "agent.refused": "Connection refused",
  "agent.failed": "Couldn’t process the request",
  "agent.keyId": "Key id",
  // ── An outside identity issuer ─────────────────────────────────────────
  "issuer.loading": "Reading the issuer…",
  "issuer.unreadable":
    "This issuer couldn’t be loaded. It may already have been decided.",
  "issuer.who":
    "An outside service, {mark}, asking that the identity tokens it signs be accepted here.",
  "issuer.what": "Only the scopes you tick below.",
  "issuer.when": "{at} ({ago}).",
  "issuer.whenVia": "{at} ({ago}), from a {via} request.",
  "issuer.needsApproval":
    "An outside service can vouch for who is calling this pod only after a pod admin trusts it, and only for what you allow.",
  "issuer.notPending": "This issuer is no longer waiting for approval.",
  "issuer.scopes": "Allowed scopes",
  "issuer.approve": "Approve access",
  "issuer.approved": "Issuer approved",
  "issuer.refused": "Issuer refused",
  "issuer.approveFailed": "Approval failed",
  "issuer.refuseFailed": "Refusing failed",
  "issuer.id": "Issuer id",
  "issuer.url": "Issuer URL",
  // ── An app asking for its origin ───────────────────────────────────────
  "app.loading": "Reading the request…",
  "app.unreadable":
    "This request couldn’t be opened. It may have expired or already been decided.",
  "app.who": "An app named {mark}.",
  "app.whoBy": "An app named {mark}, published by {publisher}.",
  "app.what":
    "Call this pod’s API from {mark} in a browser. No data access and no membership: people still need to be members.",
  "app.when": "Waiting now; the request expires {expiry}.",
  "app.needsApproval":
    "A website can call this pod from a browser only after an owner allows its exact address.",
  "app.alreadyAllowed": "Already allowed",
  "app.alreadyAllowedBody":
    "This origin is already on the allowlist for this app; the requester only needs to choose Check connection.",
  "app.approve": "Allow this origin",
  "app.allowed": "Origin allowed",
  "app.refused": "Request refused",
  "app.requestId": "Request id",
  "app.appId": "App id",
} as const;

export const fr: Catalog<typeof en> = {
  "trust.who": "Qui demande",
  "trust.what": "Ce qu’il pourra faire",
  "trust.where": "Où",
  "trust.approver": "Qui approuve",
  "trust.approverNamed":
    "Vous êtes connecté en tant que {mark}. Votre décision est inscrite au journal d’audit.",
  "trust.approverYou": "Vous. Votre décision est inscrite au journal d’audit.",
  "trust.when": "Quand et d’où",
  "where.pod": "Votre pod, {scope}",
  "where.podHost": "Votre pod {mark}, {scope}",
  "where.space": "l’espace {space} seulement.",
  "where.everywhere": "sur tout le pod.",
  "approval.lead": "Pourquoi il faut une approbation.",
  "decide.refuse": "{verb}…",
  "decide.reason": "Raison",
  "decide.reasonHint":
    "Le demandeur la voit : dites ce qui vous ferait changer d’avis.",
  "decide.confirmRefuse": "Refuser et le lui dire",
  "decide.cancel": "Laisser ouvert",
  "decide.alreadyDecided": "Déjà décidé",
  "decide.failed": "L’action n’a pas pu aboutir",
  "agent.who": "Un agent nommé {mark}.",
  "agent.whoBy": "Un agent nommé {mark}, connecté par {requester}.",
  "agent.unnamed": "cet agent",
  "agent.what":
    "Tout ce qui est listé ci-dessous, et rien d’autre. Ses écritures suivent toujours vos règles de revue.",
  "agent.when": "{at} ({ago}).",
  "agent.whenFrom": "{at} ({ago}), depuis {from}.",
  "agent.needsApproval":
    "Un nouvel agent a besoin qu’une personne approuve son accès.",
  "agent.refused": "Connexion refusée",
  "agent.failed": "La demande n’a pas pu être traitée",
  "agent.keyId": "Identifiant de la clé",
  "issuer.loading": "Lecture de l’émetteur…",
  "issuer.unreadable":
    "Cet émetteur n’a pas pu être chargé. Il a peut-être déjà été décidé.",
  "issuer.who":
    "Un service extérieur, {mark}, qui demande que les jetons d’identité qu’il signe soient acceptés ici.",
  "issuer.what": "Seulement les portées que vous cochez ci-dessous.",
  "issuer.when": "{at} ({ago}).",
  "issuer.whenVia": "{at} ({ago}), depuis une demande {via}.",
  "issuer.needsApproval":
    "Un service extérieur ne peut garantir qui appelle ce pod qu’une fois qu’un administrateur du pod lui fait confiance, et seulement pour ce que vous autorisez.",
  "issuer.notPending": "Cet émetteur n’attend plus d’approbation.",
  "issuer.scopes": "Portées autorisées",
  "issuer.approve": "Approuver l’accès",
  "issuer.approved": "Émetteur approuvé",
  "issuer.refused": "Émetteur refusé",
  "issuer.approveFailed": "L’approbation a échoué",
  "issuer.refuseFailed": "Le refus a échoué",
  "issuer.id": "Identifiant de l’émetteur",
  "issuer.url": "URL de l’émetteur",
  "app.loading": "Lecture de la demande…",
  "app.unreadable":
    "Cette demande n’a pas pu être ouverte. Elle a peut-être expiré ou déjà été décidée.",
  "app.who": "Une app nommée {mark}.",
  "app.whoBy": "Une app nommée {mark}, publiée par {publisher}.",
  "app.what":
    "Appeler l’API de ce pod depuis {mark} dans un navigateur. Aucun accès aux données ni adhésion : les personnes doivent toujours être membres.",
  "app.when": "En attente ; la demande expire {expiry}.",
  "app.needsApproval":
    "Un site ne peut appeler ce pod depuis un navigateur qu’après qu’un propriétaire a autorisé son adresse exacte.",
  "app.alreadyAllowed": "Déjà autorisée",
  "app.alreadyAllowedBody":
    "Cette origine est déjà sur la liste autorisée de cette app ; le demandeur n’a qu’à choisir Vérifier la connexion.",
  "app.approve": "Autoriser cette origine",
  "app.allowed": "Origine autorisée",
  "app.refused": "Demande refusée",
  "app.requestId": "Identifiant de la demande",
  "app.appId": "Identifiant de l’app",
};

export const DRAWER_CATALOGS = { en, fr } as const;

/** The drawer's translator, in the ambient catalog locale (outside React). */
export function drawerT() {
  return createT(ambientCatalogLocale(), DRAWER_CATALOGS);
}

/** Where `{mark}` sits in a sentence: a control character no word holds. */
export const NAME_MARK = "\u0001";
