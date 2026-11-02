/**
 * Server errors' words — the list (`/errors`) and one error's page
 * (`/errors/:errorId`) — as catalogs (`@synap-core/types/i18n`): English is
 * the source and the type. DRAFT French ("vous"), awaiting the founder's
 * review. The error's own name and message are content (what the code
 * threw): shown as written, never translated.
 */
import type { Catalog } from "@synap-core/types/i18n";

export const en = {
  title: "Server errors",
  description:
    "What failed on this pod, with its exact cause. A person who met an error quotes its errorId; open it here. Kept 30 days.",
  "lookup.placeholder": "errorId",
  "lookup.aria": "Open a server error by its errorId",
  "lookup.open": "Open",
  "list.failed": "Couldn’t load the server errors.",
  "list.empty": "No server error in the last 30 days.",
  "list.more": "Load older",
  "row.where": "{where} · {when}",
  "noun.fault": "Server error",
  "door.rest": "Hub / REST",
  "door.trpc": "App / tRPC",
  "fact.when": "When",
  "fact.request": "Request",
  "fact.status": "Status",
  "fact.door": "Door",
  "fact.caller": "Caller",
  "fact.agent": "Agent",
  "caller.none": "Before sign-in",
  "section.cause": "Cause",
  "section.chain": "What it came from",
  "section.stack": "Stack",
  "section.noStack": "No stack was recorded for this error.",
  "id.error": "errorId",
  "status.code": "HTTP {status}",
  "fail.noun": "server error",
  "fail.notFound":
    "No server error is stored under this id. Errors are kept 30 days.",
} as const;

export const fr: Catalog<typeof en> = {
  title: "Erreurs serveur",
  description:
    "Ce qui a échoué sur ce pod, avec sa cause exacte. Une personne qui a rencontré une erreur cite son errorId : ouvrez-la ici. Conservées 30 jours.",
  "lookup.placeholder": "errorId",
  "lookup.aria": "Ouvrir une erreur serveur par son errorId",
  "lookup.open": "Ouvrir",
  "list.failed": "Impossible de charger les erreurs serveur.",
  "list.empty": "Aucune erreur serveur ces 30 derniers jours.",
  "list.more": "Charger les plus anciennes",
  "row.where": "{where} · {when}",
  "noun.fault": "Erreur serveur",
  "door.rest": "Hub / REST",
  "door.trpc": "App / tRPC",
  "fact.when": "Quand",
  "fact.request": "Requête",
  "fact.status": "Statut",
  "fact.door": "Porte",
  "fact.caller": "Appelant",
  "fact.agent": "Agent",
  "caller.none": "Avant connexion",
  "section.cause": "Cause",
  "section.chain": "D’où elle vient",
  "section.stack": "Pile d’appels",
  "section.noStack":
    "Aucune pile d’appels n’a été enregistrée pour cette erreur.",
  "id.error": "errorId",
  "status.code": "HTTP {status}",
  "fail.noun": "erreur serveur",
  "fail.notFound":
    "Aucune erreur serveur n’est enregistrée sous cet identifiant. Les erreurs sont conservées 30 jours.",
};

export const ERRORS_CATALOGS = { en, fr };
