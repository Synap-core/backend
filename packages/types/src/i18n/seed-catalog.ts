/**
 * A seed catalog proving the shape: a handful of keys exercising each part of
 * the subset, read by this folder's tests only. Product copy moves into
 * catalogs folder by folder (the vocabulary first); it is not added here.
 */
import type { Catalog } from "./translator.js";

export const seedEn = {
  "seed.greeting": "Hello",
  "seed.welcome": "Welcome back, {name}",
  "seed.ideas.added":
    "{n, plural, =0 {No ideas added} one {# idea added} other {# ideas added}}",
  "seed.items.inSpace": "{n, plural, one {# item} other {# items}} in {space}",
  "seed.created":
    "{kind, select, task {Task created} project {Project created} other {Created}}",
} as const;

export const seedFr: Catalog<typeof seedEn> = {
  "seed.greeting": "Bonjour",
  "seed.welcome": "Bon retour, {name}",
  "seed.ideas.added":
    "{n, plural, =0 {Aucune idée ajoutée} one {# idée ajoutée} other {# idées ajoutées}}",
  "seed.items.inSpace":
    "{n, plural, one {# élément} many {# d’éléments} other {# éléments}} dans {space}",
  "seed.created":
    "{kind, select, task {Tâche créée} project {Projet créé} other {Créé}}",
};
