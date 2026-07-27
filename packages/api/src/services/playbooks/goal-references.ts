/**
 * Playbook goal ⇄ declared params — the author-time reference check, at the
 * BACKEND door.
 *
 * `findUnresolvedReferences` (utils/template-references.ts) already knows which
 * references `substitute()` will not resolve; until now it ran only in the
 * browser authoring surfaces, so every non-browser door (MCP, CLI, Hub, the AI
 * tool's merged-row case) could persist a goal whose `{placeholders}` no
 * declared param backs. This adapter is the ONE thing that was missing: pull
 * the declared names off the loosely-typed `params` JSONB and hand them to the
 * SAME validator. No second grammar, no second rule.
 *
 * Deliberately NOT a rejection: several live playbooks would fail it, and an
 * author must be able to save a work-in-progress goal. The caller WARNs.
 */

import type { PlaybookParam } from "@synap/playbooks";
import {
  findUnresolvedReferences,
  type UnresolvedReference,
} from "../../utils/template-references.js";

/** Declared param names off the loose `playbooks.params` JSONB. */
function declaredParamNames(params: unknown): string[] {
  if (!Array.isArray(params)) return [];
  return params
    .map((p) => (p as Partial<PlaybookParam> | null)?.name)
    .filter((n): n is string => typeof n === "string" && n.trim() !== "");
}

/**
 * Every reference in `goalTemplate` that substitution would NOT resolve given
 * the playbook's declared `params`. Empty when the goal is fully backed (or
 * when there is no goal to check).
 */
export function findUnresolvedGoalReferences(
  goalTemplate: unknown,
  params: unknown
): UnresolvedReference[] {
  if (typeof goalTemplate !== "string" || goalTemplate === "") return [];
  return findUnresolvedReferences(goalTemplate, declaredParamNames(params));
}
