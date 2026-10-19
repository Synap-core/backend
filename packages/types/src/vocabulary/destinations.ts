/**
 * Destination words — the names of the places the shell's navigation opens.
 *
 * Founder decision 2A (2026-10-19): the sidebar reads Home · Inbox · Work ·
 * Library, then Projects and Spaces, with Agents by the account; the bucket of
 * things filed into no project is "Unfiled". Home's first-run card is "Getting
 * started". (The Inbox's four filters — decision 3A — are NOT here: they are
 * `NEEDS_YOU_BUCKETS` and their words `NEEDS_YOU_BUCKET_LABELS`, keyed by the
 * bucket the shared rule files a row under.) The glossary
 * (`synap-backend/skills/synap/concepts.md`) defines each word once.
 *
 * WHY A TABLE, not `humanizeToken(id)`: each word names a value in the type
 * system (a manifest app id, a rail id, a filter key) whose id is not its word.
 * Work's app id is `sessions`, Library's is `data`, Agents opens a Settings
 * section. One row each, so a rename is one line and every surface (browser
 * rail, relay bar, palette, page headers) follows.
 *
 * Projects, Spaces and Agents are the registry's own plurals, read from
 * `OBJECT_KINDS` (never retyped), so a destination can never disagree with the
 * noun of the objects it lists.
 *
 * The TABLES read only `./object-kinds`: they are built at module load, while
 * `./index` (which re-exports this file) is still evaluating. `humanizeToken`
 * is called only inside the resolvers, at call time — the `tool-labels.ts`
 * precedent.
 */
import { OBJECT_KINDS } from "./object-kinds.js";
import { humanizeToken } from "./index.js";

export const DESTINATIONS = [
  "home",
  "inbox",
  "work",
  "library",
  "projects",
  "spaces",
  "agents",
  "unfiled",
  "getting_started",
] as const;
export type Destination = (typeof DESTINATIONS)[number];

export const DESTINATION_LABELS: Readonly<Record<Destination, string>> = {
  home: "Home",
  // Everything that needs you: decisions, questions, routine changes, broken work.
  inbox: "Inbox",
  // What is moving, and the sessions behind it ("Start work" — no noun for a session).
  work: "Work",
  // What you and your agents brought in: things, files, imports.
  library: "Library",
  projects: OBJECT_KINDS.project!.labelPlural,
  spaces: OBJECT_KINDS.workspace!.labelPlural,
  agents: OBJECT_KINDS.agent!.labelPlural,
  // Things filed into no project (was "Not in a project").
  unfiled: "Unfiled",
  getting_started: "Getting started",
};

/** The word for a destination. Unknown values humanize, never leak. */
export function resolveDestinationLabel(
  destination: string | null | undefined
): string {
  if (!destination) return "";
  const key = destination.trim().toLowerCase().replace(/-/g, "_");
  return (
    (DESTINATION_LABELS as Record<string, string>)[key] ?? humanizeToken(key)
  );
}
