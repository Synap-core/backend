/**
 * The words of a large approval's progress (the toast and the review's decision
 * bar), as catalogs (`@synap-core/types/i18n`): English is the source and the
 * type. DRAFT French, awaiting the founder's review. Counts arrive twice: `n`
 * is the formatted number a person reads, `count` the raw one that picks the
 * plural. Verbs (Resume, Try again) come from the vocabulary door, not here.
 */
import {
  ambientCatalogLocale,
  createT,
  type Catalog,
} from "@synap-core/types/i18n";

export const en = {
  approving: "Approving…",
  "counts.created": "{count, plural, one {{n} created} other {{n} created}}",
  "counts.linked":
    "{count, plural, one {{n} already there} other {{n} already there}}",
  "counts.failed": "{count, plural, one {{n} failed} other {{n} failed}}",
  "queued.title":
    "Waiting to start: {count, plural, one {{n} change} other {{n} changes}}",
  "queued.detail": "Another large approval is ahead of it.",
  "running.finishing": "Finishing up: {done} of {total}",
  "running.creating": "Creating records: {done} of {total}",
  "done.title":
    "Approved: {count, plural, one {{n} change applied} other {{n} changes applied}}",
  "done.relationsFailed":
    "{count, plural, one {{n} connection did not land} other {{n} connections did not land}}",
  "done.skipped":
    "{count, plural, one {{n} left out: several existing records share the name} other {{n} left out: several existing records share the name}}",
  "stopped.title": "Stopped at {done} of {total}",
  "stopped.detail":
    "The approval stopped before it finished. What was created is kept.",
  "stopped.twinNamed": "Stopped at {done} of {total}: “{name}” already exists",
  "stopped.twin": "Stopped at {done} of {total}: a record already exists",
  "stopped.twinDetail":
    "Choose what happens to every record that already exists, then the approval goes on. What was created is kept.",
  "unavailable.title": "Can’t read the approval’s progress",
  "unavailable.detail": "It may still be applying. Check again in a moment.",
  door: "See what was created",
} as const;

export const fr: Catalog<typeof en> = {
  approving: "Approbation en cours…",
  "counts.created": "{count, plural, one {{n} créée} other {{n} créées}}",
  "counts.linked":
    "{count, plural, one {{n} déjà présente} other {{n} déjà présentes}}",
  "counts.failed": "{count, plural, one {{n} en échec} other {{n} en échec}}",
  "queued.title":
    "En attente de démarrage : {count, plural, one {{n} modification} other {{n} modifications}}",
  "queued.detail": "Une autre grosse approbation passe avant celle-ci.",
  "running.finishing": "Finalisation : {done} sur {total}",
  "running.creating": "Création des fiches : {done} sur {total}",
  "done.title":
    "Approuvée : {count, plural, one {{n} modification appliquée} other {{n} modifications appliquées}}",
  "done.relationsFailed":
    "{count, plural, one {{n} lien n’a pas pu être créé} other {{n} liens n’ont pas pu être créés}}",
  "done.skipped":
    "{count, plural, one {{n} laissée de côté : plusieurs fiches existantes portent le même nom} other {{n} laissées de côté : plusieurs fiches existantes portent le même nom}}",
  "stopped.title": "Arrêtée à {done} sur {total}",
  "stopped.detail":
    "L’approbation s’est arrêtée avant la fin. Ce qui a été créé est conservé.",
  "stopped.twinNamed": "Arrêtée à {done} sur {total} : « {name} » existe déjà",
  "stopped.twin": "Arrêtée à {done} sur {total} : une fiche existe déjà",
  "stopped.twinDetail":
    "Choisissez ce qui arrive à chaque fiche déjà existante, puis l’approbation continue. Ce qui a été créé est conservé.",
  "unavailable.title": "Impossible de lire la progression de l’approbation",
  "unavailable.detail":
    "Elle est peut-être encore en cours. Vérifiez à nouveau dans un instant.",
  door: "Voir ce qui a été créé",
};

/** The progress words' translator, in the ambient catalog locale. */
export function approvalProgressT() {
  return createT(ambientCatalogLocale(), { en, fr });
}
