/**
 * Réglages' words (the language, and how requests are laid out), as catalogs
 * (`@synap-core/types/i18n`): English is the source and the type. A language
 * is named in its own words in every catalog ("Français", "English").
 * Package, grouping and layout names come from the vocabulary. DRAFT French
 * ("vous"), awaiting the founder's review.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Settings",
  description: "Your language, and how requests from your AIs are laid out.",
  "language.title": "Language",
  "language.hint": "The language this site speaks to you, on every device.",
  "language.en": "English",
  "language.fr": "Français",
  "language.failed": "Couldn’t change the language",
  "language.failedHint": "Nothing changed. Try again.",
  "groupBy.title": "Group requests by",
  "groupBy.unread":
    "Your saved choice couldn’t be read; requests are grouped by kind of decision until it can.",
  "groupBy.hint.package":
    "By the decision each request asks: questions first, then access, releases, rules, changes, hand-offs, knowledge and bookkeeping.",
  "groupBy.hint.work":
    "Each piece of work shows its questions and its changes together.",
  "groupBy.hint.agent": "Each AI shows what it asks for.",
  "groupBy.hint.time": "One list, newest first.",
  "layout.title": "Layout of each kind of decision",
  "layout.hint":
    "Each kind of decision opens in its own shape. Switch any of them to a plain list.",
  "layout.aria": "{name}: layout",
  "handOffs.title": "Hand-offs you always allow",
  "handOffs.hint":
    "An AI here may pass work to another AI without asking you. It never covers deletes or access.",
  "handOffs.failed": "Couldn’t load your AIs and their rules.",
  "handOffs.empty": "No AI works for you yet.",
  "handOffs.on": "Always allowed",
  "handOffs.off": "Asks you",
  "handOffs.aria": "{name}: always allow hand-offs",
  "handOffs.allowed": "{name} may take hand-offs without asking",
  "handOffs.asksAgain": "{name} asks again before taking hand-offs",
  "handOffs.notChanged": "Couldn’t change this rule",
  "handOffs.notChangedHint": "Nothing changed. Try again.",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Réglages",
  description: "Votre langue, et la présentation des demandes de vos IA.",
  "language.title": "Langue",
  "language.hint": "La langue de ce site, sur tous vos appareils.",
  "language.en": "English",
  "language.fr": "Français",
  "language.failed": "Impossible de changer la langue",
  "language.failedHint": "Rien n’a changé. Réessayez.",
  "groupBy.title": "Regrouper les demandes par",
  "groupBy.unread":
    "Votre choix n’a pas pu être lu ; les demandes sont regroupées par type de décision en attendant.",
  "groupBy.hint.package":
    "Selon la décision demandée : les questions d’abord, puis les accès, les mises en service, les règles, les modifications, les passations, les connaissances et le suivi.",
  "groupBy.hint.work":
    "Chaque travail montre ses questions et ses modifications ensemble.",
  "groupBy.hint.agent": "Chaque IA montre ce qu’elle demande.",
  "groupBy.hint.time":
    "Une seule liste, de la plus récente à la plus ancienne.",
  "layout.title": "Présentation de chaque type de décision",
  "layout.hint":
    "Chaque type de décision s’ouvre dans sa propre forme. Passez-en n’importe lequel en simple liste.",
  "layout.aria": "{name} : présentation",
  "handOffs.title": "Passations toujours autorisées",
  "handOffs.hint":
    "Une IA de cette liste peut confier du travail à une autre IA sans vous demander. Cela ne couvre jamais les suppressions ni les accès.",
  "handOffs.failed": "Impossible de charger vos IA et leurs règles.",
  "handOffs.empty": "Aucune IA ne travaille encore pour vous.",
  "handOffs.on": "Toujours autorisé",
  "handOffs.off": "Vous demande",
  "handOffs.aria": "{name} : toujours autoriser les passations",
  "handOffs.allowed": "{name} peut confier du travail sans vous demander",
  "handOffs.asksAgain":
    "{name} vous demandera de nouveau avant de confier du travail",
  "handOffs.notChanged": "Impossible de modifier cette règle",
  "handOffs.notChangedHint": "Rien n’a changé. Réessayez.",
};
