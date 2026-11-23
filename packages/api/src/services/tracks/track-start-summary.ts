/**
 * LEAF (no db, no service imports — `permission-check.ts` imports it
 * statically): the summary of a track start made from an entity.
 */

import {
  buildObjectActionTitle,
  nounInSentence,
  resolveObjectNoun,
  resolveTrackStatusLabel,
  resolveTrackVerdictLabel,
} from "@synap-core/types/vocabulary";

/**
 * The `track/create` proposal summary when the goal is made from an entity
 * ("Make it a goal", D2 — `Create Goal "X" from objective "Y"`, and for an
 * entity that had ended ` — Closed (Met)` / ` — Dropped (No longer needed)`).
 * Every word from the one door (the noun, the status and the verdict), so the
 * head and the tail never name a thing twice differently. `null` ⇒ the
 * caller's generic title applies.
 */
export function buildTrackStartSummary(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
): string | null {
  if (subjectType !== "track" || action !== "create") return null;
  const from = fromEntityClause(data.fromEntity);
  if (!from) return null;
  const head = buildObjectActionTitle({
    action: "create",
    objectKind: "track",
    objectName: typeof data.name === "string" ? data.name : null,
  });
  return `${head}${from}`;
}

function fromEntityClause(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.kind !== "string" || typeof f.title !== "string") return null;
  const ended =
    f.ended && typeof f.ended === "object"
      ? (f.ended as Record<string, unknown>)
      : null;
  const ending =
    ended &&
    typeof ended.status === "string" &&
    typeof ended.verdict === "string"
      ? ` — ${resolveTrackStatusLabel(ended.status)} (${resolveTrackVerdictLabel(ended.verdict)})`
      : "";
  return ` from ${nounInSentence(resolveObjectNoun(f.kind))} "${f.title}"${ending}`;
}
