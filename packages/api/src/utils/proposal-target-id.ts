import { randomUUID } from "crypto";

/**
 * The id a filed proposal names as its target.
 *
 * - An ENTITY write names its record in `data.id`; a `documentId` beside it is
 *   the body being attached, not the target (read first, it filed every body
 *   attach against the document).
 * - A DOCUMENT create names the document it will make in `data.id` (the filer
 *   pre-allocates it, and the approval writes the row under exactly that id,
 *   `document/create` -> `proposal.targetId`). It is read first, so a stray
 *   `documentId` / `entityId` beside it can never become a different target and
 *   the review page can always open the document an approval created.
 * - Anything else keeps the historical order. A random id is the last resort.
 */
export function resolveProposalTargetId(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
): string {
  const isEntity = subjectType === "entity" || subjectType === "entities";
  const isDocumentCreate =
    (subjectType === "document" || subjectType === "documents") &&
    action === "create";
  const named = isEntity
    ? data.id || data.entityId
    : isDocumentCreate
      ? data.id
      : undefined;
  return (named ||
    data.documentId ||
    data.entityId ||
    data.id ||
    randomUUID()) as string;
}
