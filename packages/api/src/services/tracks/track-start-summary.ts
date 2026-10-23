/**
 * LEAF (no db, no service imports — `permission-check.ts` imports it
 * statically): the consent sentence of a track start that carries a space
 * grant (decision 2a; see `track-space-grant.ts`).
 */

import {
  buildObjectActionTitle,
  nounInSentence,
  resolveObjectNoun,
  resolveTrackStatusLabel,
  resolveTrackVerdictLabel,
} from "@synap-core/types/vocabulary";

/** The key on `project_tracks.metadata` AND on the `track/create` payload. */
export const TRACK_SPACE_GRANT_KEY = "spaceGrant";

/**
 * The `track/create` proposal summary when the start carries something the
 * person consents to beyond "create": the goal is made from an entity ("Make
 * it a goal", D2 — `Create Goal "X" from objective "Y"`, and for an entity
 * that had ended ` — Closed (Met)` / ` — Dropped (No longer needed)`), and/or
 * a space grant (decision 2a — ` and let <agent> work in Strategy, Finance for
 * this goal`). Every word from the one door (the noun, the status and the
 * verdict), so the head and the tail never name a thing twice differently.
 * `null` ⇒ neither rides this proposal; the caller's generic title applies.
 */
export function buildTrackStartSummary(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
): string | null {
  if (subjectType !== "track" || action !== "create") return null;
  const from = fromEntityClause(data.fromEntity);
  const grant = spaceGrantClause(data[TRACK_SPACE_GRANT_KEY]);
  if (!from && !grant) return null;
  const head = buildObjectActionTitle({
    action: "create",
    objectKind: "track",
    objectName: typeof data.name === "string" ? data.name : null,
  });
  return `${head}${from ?? ""}${grant ?? ""}`;
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

function spaceGrantClause(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const names = Array.isArray(g.spaces)
    ? g.spaces
        .map((s) =>
          s && typeof s === "object"
            ? (s as Record<string, unknown>).name
            : null
        )
        .filter((n): n is string => typeof n === "string" && !!n.trim())
    : [];
  if (names.length === 0) return null;
  const agent =
    typeof g.agentName === "string" && g.agentName.trim()
      ? g.agentName
      : "the agent";
  const noun = nounInSentence(resolveObjectNoun("track"));
  return ` and let ${agent} work in ${names.join(", ")} for this ${noun}`;
}
