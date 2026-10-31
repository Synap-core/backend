/**
 * The words of Home's status sections (« À vous » / "Your move" and « Ça
 * avance sans vous » / "Moving without you", the status-first canvas), as
 * catalogs (`@synap-core/types/i18n`): English is the source and the type,
 * French translates it ("vous"). Shared by the phone (relay `HomeBrief`) and
 * the browser Home, so neither keeps a local catalog. A `{items}` param is a
 * vocabulary noun phrase (`resolveNeedsYouItemCount`), shown as given.
 * DRAFT French, awaiting the founder's review with the vocabulary's.
 */
import { ambientCatalogLocale } from "../i18n/ambient.js";
import { createT, type Catalog, type Locale } from "../i18n/index.js";

export const en = {
  /** The section of what waits on the person: their move. */
  "home.yours.title": "Your move",
  /** The routine changes, as ONE line under the moves (never three of them). */
  "home.yours.routine": "Plus {items}, reversible.",
  "home.yours.routine.preview": "Preview",
  "home.yours.routine.preview.a11y": "Preview {items}",
  /** The door to the whole list, under the capped moves; its count rides beside it. */
  "home.yours.all": "All that needs you",
  /** A move put off: a date hold (the swipe left, the "Later" button). */
  "home.yours.later": "Later",
  /** How much work moves when the person answers (the WaitingQueue badge). */
  "home.yours.frees": "{n, plural, one {frees #} other {frees #}}",
  /** The section of work moving on its own: agents, machines, other people. */
  "home.moving.title": "Moving without you",
  /** The door to the Work list, under the capped rows. */
  "home.moving.all": "See all",
  "home.moving.all.a11y": "See all the work moving now",
  /** The read that failed, as a noun phrase for the failed-read title. */
  "home.moving.what": "what is moving",

  /** The failed-read nouns of Home's other reads (a failed-read card's `what`). */
  "home.needsYou.what": "what needs you",
  "home.health.what": "your pod’s health",
  "home.projects.what": "your projects",
  "home.projects.title": "Where your projects stand",
  "home.projects.empty.title": "No project yet.",
  "home.projects.empty.body":
    "A project gathers the work for one goal, across your spaces.",
  /** The doors under the brief. */
  "home.spaces": "Spaces",
  "home.spaces.a11y": "Your spaces",
  "home.todo": "To-do",
  "home.todo.due":
    "{n, plural, one {# due or overdue} other {# due or overdue}}",
  "home.todo.a11y":
    "To-do, {n, plural, one {# due or overdue} other {# due or overdue}}",
  "home.undo": "Undo a change",
  "home.undo.a11y": "Recent changes, each with its Undo",
  "home.activity": "Activity & suggestions",
  "home.activity.a11y": "Activity and suggestions across your pod",
} as const;

export const fr: Catalog<typeof en> = {
  "home.yours.title": "À vous",
  "home.yours.routine": "Plus {items}, réversibles.",
  "home.yours.routine.preview": "Aperçu",
  "home.yours.routine.preview.a11y": "Aperçu : {items}",
  "home.yours.all": "Tout ce qui vous attend",
  "home.yours.later": "Plus tard",
  "home.yours.frees":
    "{n, plural, one {débloque #} many {débloque #} other {débloque #}}",
  "home.moving.title": "Ça avance sans vous",
  "home.moving.all": "Tout voir",
  "home.moving.all.a11y": "Voir tout le travail en cours",
  "home.moving.what": "ce qui avance",

  "home.needsYou.what": "ce qui vous attend",
  "home.health.what": "l’état de votre pod",
  "home.projects.what": "vos projets",
  "home.projects.title": "Où en sont vos projets",
  "home.projects.empty.title": "Aucun projet pour l’instant.",
  "home.projects.empty.body":
    "Un projet rassemble le travail pour un objectif, dans tous vos espaces.",
  "home.spaces": "Espaces",
  "home.spaces.a11y": "Vos espaces",
  "home.todo": "À faire",
  "home.todo.due":
    "{n, plural, one {# à faire ou en retard} many {# à faire ou en retard} other {# à faire ou en retard}}",
  "home.todo.a11y":
    "À faire, {n, plural, one {# à faire ou en retard} many {# à faire ou en retard} other {# à faire ou en retard}}",
  "home.undo": "Annuler une modification",
  "home.undo.a11y": "Modifications récentes, chacune avec son Annuler",
  "home.activity": "Activité et suggestions",
  "home.activity.a11y": "Activité et suggestions dans votre pod",
};

/** Home's catalogs, for a surface that composes its own translator. */
export const homeCopy = { en, fr } as const;

/** Home's translator, in `locale` (else the ambient catalog locale). */
export function homeT(locale?: Locale) {
  return createT(locale ?? ambientCatalogLocale(), homeCopy);
}
