/**
 * The review title of a PROJECT FILING proposal — PURE, leaf, no DB.
 *
 *   project/file_entities                → `File 9 questions into project "Launch The Architech"`
 *   link/delete (belongs_to_project)     → `Unfile 9 questions from project "Launch The Architech"`
 *
 * The generic `<verb> <noun> "<name>"` composition cannot carry a filing: it
 * names TWO things (how many records of what kind, and which project), so it
 * read `File entities Project "…"`. Every word still comes from the ONE
 * vocabulary door (`resolveActionLabel`, `resolveObjectNoun(Plural)`) — this is
 * a composition, not a second label table (`.claude/rules/vocabulary.md`).
 *
 * The payload fields (`entityIds`, `entityKind`, `entityName`, `projectName`)
 * are stamped by `services/projects/file-entities.ts`, which resolved them on
 * the caller's own floor before the gate ran.
 */

import {
  resolveActionLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "@synap-core/types/vocabulary";

/** Relation slug of the filing edge (kept local: this module stays a leaf). */
const BELONGS_TO_PROJECT = "belongs_to_project";

/** True for the `link/delete` payload the un-file door files. */
export function isProjectUnfilePayload(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
): boolean {
  return (
    (subjectType === "link" || subjectType === "links") &&
    action === "delete" &&
    data.linkType === BELONGS_TO_PROJECT &&
    data.toType === "project"
  );
}

export function buildProjectFilingSummary(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
): string | null {
  const isFile =
    (subjectType === "project" || subjectType === "projects") &&
    action === "file_entities";
  const isUnfile = isProjectUnfilePayload(subjectType, action, data);
  if (!isFile && !isUnfile) return null;

  const count = Array.isArray(data.entityIds) ? data.entityIds.length : 0;
  const kind =
    typeof data.entityKind === "string" && data.entityKind
      ? data.entityKind
      : "entity";
  const single =
    count === 1 && typeof data.entityName === "string" && data.entityName.trim()
      ? `"${data.entityName.trim()}"`
      : null;
  const what =
    single ??
    `${count} ${(count === 1
      ? resolveObjectNoun(kind)
      : resolveObjectNounPlural(kind)
    ).toLowerCase()}`;
  const projectNoun = resolveObjectNoun("project").toLowerCase();
  const where =
    typeof data.projectName === "string" && data.projectName.trim()
      ? `${projectNoun} "${data.projectName.trim()}"`
      : `a ${projectNoun}`;
  const verb = resolveActionLabel(
    isFile ? "file_entities" : "unfile_entities",
    "imperative"
  );
  return `${verb} ${what} ${isFile ? "into" : "from"} ${where}`;
}
