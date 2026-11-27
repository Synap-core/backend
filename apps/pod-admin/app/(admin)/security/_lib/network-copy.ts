/**
 * Pod security › Network's words, as catalogs (`@synap-core/types/i18n`):
 * English is the source and the type. DRAFT French ("vous"), awaiting the
 * founder's review. Host names, automation names, a person's name and the
 * reason someone typed are content, shown as written.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  "network.title": "Sites your AIs read data from",
  "network.hint":
    "Your AIs can read open data (public JSON APIs that need no key) only from these sites, over https. An AI asks for a new one in Review.",
  "network.add": "Add a site",
  "network.adminOnly": "Only a pod admin can add or remove a site.",
  "network.loading": "Loading the sites…",
  "network.failed": "Couldn’t load the sites your AIs may read.",
  "network.empty":
    "No site yet: your AIs can’t read any JSON API until one is added.",
  "network.addedBy": "Added by {name} {when}",
  "network.addedWhen": "Added {when}",
  "network.why": "Why: {reason}",
  "network.approval": "See the approval",
  "network.usedBy":
    "Read by {n, plural, one {the automation {names}} other {# automations: {names}}}",
  "network.notUsed": "No automation reads it.",
  "network.unread":
    "{n, plural, one {# automation builds} other {# automations build}} the address while it runs, so it isn’t listed under a site.",
  "network.remove": "Remove",
  "network.remove.title": "Remove {host}?",
  "network.remove.consequence":
    "Your AIs can no longer read from {host}. Nothing else on the pod changes, and you can add it again later.",
  "network.remove.consequenceUsed":
    "Your AIs can no longer read from {host}. {n, plural, one {# automation reads it and will be refused} other {# automations read it and will be refused}} until it is added again.",
  "network.remove.confirm": "Remove site",
  "network.removed": "{host} removed",
  "network.removeFailed": "Couldn’t remove the site.",
  "network.form.title": "Add a site",
  "network.form.submit": "Add site",
  "network.form.host": "Site",
  "network.form.hostHint":
    "The name only, without https:// or a path, e.g. recherche-entreprises.api.gouv.fr",
  "network.form.reason": "Why (optional)",
  "network.form.reasonHint":
    "Kept with the site, for the people who read this list.",
  "network.form.failed": "Couldn’t add the site.",
  "network.added": "{host} added",
  "network.alreadyAllowed": "{host} was already on the list",
} as const;

export const fr: Catalog<typeof en> = {
  "network.title": "Sites où vos IA lisent des données",
  "network.hint":
    "Vos IA ne peuvent lire des données ouvertes (des API JSON publiques sans clé) que sur ces sites, en https. Une IA demande un nouveau site dans Revue.",
  "network.add": "Ajouter un site",
  "network.adminOnly":
    "Seul un administrateur du pod peut ajouter ou retirer un site.",
  "network.loading": "Chargement des sites…",
  "network.failed": "Impossible de charger les sites que vos IA peuvent lire.",
  "network.empty":
    "Aucun site pour l’instant : vos IA ne peuvent lire aucune API JSON tant qu’aucun n’est ajouté.",
  "network.addedBy": "Ajouté par {name} {when}",
  "network.addedWhen": "Ajouté {when}",
  "network.why": "Pourquoi : {reason}",
  "network.approval": "Voir l’approbation",
  "network.usedBy":
    "Lu par {n, plural, one {l’automatisation {names}} other {# automatisations : {names}}}",
  "network.notUsed": "Aucune automatisation ne le lit.",
  "network.unread":
    "{n, plural, one {# automatisation construit} other {# automatisations construisent}} l’adresse pendant l’exécution : elle n’est donc listée sous aucun site.",
  "network.remove": "Retirer",
  "network.remove.title": "Retirer {host} ?",
  "network.remove.consequence":
    "Vos IA ne pourront plus lire depuis {host}. Rien d’autre ne change sur le pod, et vous pourrez le rajouter plus tard.",
  "network.remove.consequenceUsed":
    "Vos IA ne pourront plus lire depuis {host}. {n, plural, one {# automatisation le lit et sera refusée} other {# automatisations le lisent et seront refusées}} tant qu’il n’est pas rajouté.",
  "network.remove.confirm": "Retirer le site",
  "network.removed": "{host} retiré",
  "network.removeFailed": "Impossible de retirer le site.",
  "network.form.title": "Ajouter un site",
  "network.form.submit": "Ajouter le site",
  "network.form.host": "Site",
  "network.form.hostHint":
    "Le nom seul, sans https:// ni chemin, par ex. recherche-entreprises.api.gouv.fr",
  "network.form.reason": "Pourquoi (facultatif)",
  "network.form.reasonHint":
    "Gardé avec le site, pour les personnes qui lisent cette liste.",
  "network.form.failed": "Impossible d’ajouter le site.",
  "network.added": "{host} ajouté",
  "network.alreadyAllowed": "{host} était déjà dans la liste",
};
