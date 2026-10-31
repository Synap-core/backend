/**
 * One secret's page (`/my-vault/[id]`): its words, as catalogs
 * (`@synap-core/types/i18n`). English is the source and the type. DRAFT French
 * ("vous"), awaiting the founder's review.
 *
 * The vault is NOT zero-knowledge and nothing here says it is (see
 * `../page.tsx`): the pod holds the key that lets an agent use a credential
 * you grant it. What the vault guarantees is isolation, and these sentences
 * say only that.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  list: "My vault",
  loading: "Loading this secret…",
  retry: "Try again",
  "status.compromised": "Marked compromised",
  "status.shared": "Agents can use it",
  "status.private": "Only you",
  "status.unknown": "Not fully read",
  "summary.compromised":
    "You marked this secret as compromised. Rotate it at the service it belongs to; grants below still work until you revoke them.",
  "summary.shared":
    "{n, plural, one {# grant lets} other {# grants let}} an agent or a space use this secret.",
  "summary.private": "Nobody but you can use it: it has no active grant.",
  "summary.unknown":
    "Whether this secret is marked compromised couldn’t be read.",
  "noun.fallback": "Secret",
  "grants.title": "Who may use it",
  "grants.hint": "Grants you gave. Revoking one takes effect immediately.",
  "grants.empty": "No grant: nobody but you can use this secret.",
  "grants.ended": "Ended grants",
  "grants.to": "Given to {who}",
  "grants.detail.expires": "expires {when}",
  "grants.detail.expired": "expired {when}",
  "grants.detail.revoked": "revoked {when}",
  "grants.detail.usesLeft": "{n, plural, one {# use left} other {# uses left}}",
  "grantee.named.agent": "{name} (agent)",
  "grantee.named.user": "{name}",
  "grantee.named.space": "Space {name}",
  "grantee.bare.agent": "An agent ({id})",
  "grantee.bare.user": "A person ({id})",
  "grantee.bare.unknown": "An agent or a person ({id})",
  "grantee.bare.space": "A space ({id})",
  "grants.status.active": "Active",
  "grants.status.expired": "Expired",
  "grants.status.revoked": "Revoked",
  "grants.status.exhausted": "No uses left",
  "grants.revoke": "Revoke",
  "grants.revoke.aria": "Revoke the grant to {who}",
  "grants.revoke.title": "Revoke this grant?",
  "grants.revoke.consequence":
    "{who} can no longer use this secret. A use already in progress is not undone. You can give a new grant later.",
  "grants.revoke.confirm": "Revoke grant",
  "grants.revoked": "Grant revoked",
  "grants.revokeFailed": "Couldn’t revoke the grant",
  "usages.title": "What uses it",
  "usages.hint": "Where this secret is attached.",
  "usages.empty": "Nothing uses this secret yet.",
  "usages.open": "Open",
  "activity.title": "Activity",
  "activity.empty": "No activity recorded yet.",
  "activity.row": "{action} by {who}",
  "activity.agent": "{who} (agent)",
  "activity.more": "Show all {n}",
  "activity.less": "Show fewer",
  "fact.lastUsed": "Last used",
  "fact.lastUsed.never": "Never used",
  "fact.lastUsed.unknown": "Couldn’t be read",
  "fact.created": "Created",
  "fact.updated": "Updated",
  "fact.category": "Category",
  "fact.address": "Address",
  "fact.id": "Secret ID",
  "settings.link": "Open Settings → Vault",
  "danger.compromised.label": "Mark as compromised",
  "danger.compromised.description": "When you think this secret has leaked.",
  "danger.compromised.consequence":
    "The secret is flagged as compromised everywhere you see it. It does not change the password or key at the service, and it does not revoke grants: rotate it there, and revoke grants above.",
  "danger.compromised.confirm": "Mark as compromised",
  "danger.compromised.done": "Marked as compromised",
  "danger.compromised.failed": "Couldn’t mark it",
  "danger.delete.label": "Delete this secret",
  "danger.delete.description": "When you no longer need it.",
  "danger.delete.consequence":
    "The stored value stops being resolvable, and any grant on it stops working the next time an agent tries to use it. It does not change the password or key at the service it belongs to. The row is kept internally so its audit trail survives; it will no longer appear here.",
  "danger.delete.confirm": "Delete secret",
  "danger.delete.done": "Secret deleted",
  "danger.delete.failed": "Couldn’t delete",
} as const;

export const fr: Catalog<typeof en> = {
  list: "Mon coffre",
  loading: "Chargement du secret…",
  retry: "Réessayer",
  "status.compromised": "Marqué compromis",
  "status.shared": "Des agents peuvent l’utiliser",
  "status.private": "Vous seul",
  "status.unknown": "Lecture incomplète",
  "summary.compromised":
    "Vous avez marqué ce secret comme compromis. Changez-le chez le service concerné ; les accès ci-dessous fonctionnent tant que vous ne les révoquez pas.",
  "summary.shared":
    "{n, plural, one {# accès permet} other {# accès permettent}} à un agent ou à un espace d’utiliser ce secret.",
  "summary.private":
    "Personne d’autre que vous ne peut l’utiliser : il n’a aucun accès actif.",
  "summary.unknown":
    "Impossible de lire si ce secret est marqué comme compromis.",
  "noun.fallback": "Secret",
  "grants.title": "Qui peut l’utiliser",
  "grants.hint":
    "Les accès que vous avez donnés. Une révocation est immédiate.",
  "grants.empty":
    "Aucun accès : personne d’autre que vous ne peut utiliser ce secret.",
  "grants.ended": "Accès terminés",
  "grants.to": "Donné à {who}",
  "grants.detail.expires": "expire {when}",
  "grants.detail.expired": "expiré {when}",
  "grants.detail.revoked": "révoqué {when}",
  "grants.detail.usesLeft":
    "{n, plural, one {# utilisation restante} other {# utilisations restantes}}",
  "grantee.named.agent": "{name} (agent)",
  "grantee.named.user": "{name}",
  "grantee.named.space": "Espace {name}",
  "grantee.bare.agent": "Un agent ({id})",
  "grantee.bare.user": "Une personne ({id})",
  "grantee.bare.unknown": "Un agent ou une personne ({id})",
  "grantee.bare.space": "Un espace ({id})",
  "grants.status.active": "Actif",
  "grants.status.expired": "Expiré",
  "grants.status.revoked": "Révoqué",
  "grants.status.exhausted": "Plus d’utilisation",
  "grants.revoke": "Révoquer",
  "grants.revoke.aria": "Révoquer l’accès donné à {who}",
  "grants.revoke.title": "Révoquer cet accès ?",
  "grants.revoke.consequence":
    "{who} ne peut plus utiliser ce secret. Une utilisation déjà en cours n’est pas annulée. Vous pourrez donner un nouvel accès plus tard.",
  "grants.revoke.confirm": "Révoquer l’accès",
  "grants.revoked": "Accès révoqué",
  "grants.revokeFailed": "Impossible de révoquer l’accès",
  "usages.title": "Ce qui l’utilise",
  "usages.hint": "Les endroits où ce secret est rattaché.",
  "usages.empty": "Rien n’utilise encore ce secret.",
  "usages.open": "Ouvrir",
  "activity.title": "Activité",
  "activity.empty": "Aucune activité enregistrée pour l’instant.",
  "activity.row": "{action} par {who}",
  "activity.agent": "{who} (agent)",
  "activity.more": "Tout afficher ({n})",
  "activity.less": "Afficher moins",
  "fact.lastUsed": "Dernière utilisation",
  "fact.lastUsed.never": "Jamais utilisé",
  "fact.lastUsed.unknown": "Lecture impossible",
  "fact.created": "Créé",
  "fact.updated": "Modifié",
  "fact.category": "Catégorie",
  "fact.address": "Adresse",
  "fact.id": "Identifiant du secret",
  "settings.link": "Ouvrir Réglages → Coffre",
  "danger.compromised.label": "Marquer comme compromis",
  "danger.compromised.description": "Quand vous pensez que ce secret a fuité.",
  "danger.compromised.consequence":
    "Le secret est signalé comme compromis partout où vous le voyez. Cela ne change ni le mot de passe ni la clé chez le service, et ne révoque aucun accès : changez-le là-bas, et révoquez les accès ci-dessus.",
  "danger.compromised.confirm": "Marquer comme compromis",
  "danger.compromised.done": "Marqué comme compromis",
  "danger.compromised.failed": "Impossible de le marquer",
  "danger.delete.label": "Supprimer ce secret",
  "danger.delete.description": "Quand vous n’en avez plus besoin.",
  "danger.delete.consequence":
    "La valeur enregistrée ne peut plus être utilisée, et tout accès donné dessus cesse de fonctionner dès qu’un agent essaie de s’en servir. Cela ne change pas le mot de passe ni la clé chez le service concerné. La ligne est conservée en interne pour garder sa piste d’audit ; elle n’apparaîtra plus ici.",
  "danger.delete.confirm": "Supprimer le secret",
  "danger.delete.done": "Secret supprimé",
  "danger.delete.failed": "Impossible de supprimer",
};

export const SECRET_CATALOGS = { en, fr };

/** The page's translator in the ambient catalog locale, for the pure model. */
export function secretT() {
  return createT(ambientCatalogLocale(), SECRET_CATALOGS);
}
