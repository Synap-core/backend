/**
 * What a playbook is matched ON, and the description an agent is shown — ONE
 * definition for the two doors that rank playbooks against a person's words:
 * `matchSessionTemplate` (synap_find's playbooks arm, the start door) and
 * `matchPlaybooks` (synap_match_playbooks, `playbooks.match`, the UI strips).
 * Both rank with `rankRouteCandidates`; before this module the find door
 * ranked name + description + goal + stage names and the match door name +
 * goal only, so the same words could rank the same pool two ways (audit
 * 732371eb §4: "two search doors disagree on the same words").
 *
 * The description is the playbook's own "when to use me". Neither door
 * returned it, so an agent choosing between "Enhance a recorded video" and
 * "Work a take" saw two names and a score (finding 9463e6b3).
 */

/** The longest description a match row carries, in characters. */
export const PLAYBOOK_DESCRIPTION_CAP = 300;

interface SearchablePlaybook {
  description?: string | null;
  goalTemplate?: string | null;
  stages?: unknown;
}

function stageNames(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) => (s as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === "string");
}

/** The words a playbook is matched on, beside its name. */
export function playbookSearchText(p: SearchablePlaybook): string[] {
  return [p.description ?? "", p.goalTemplate ?? "", ...stageNames(p.stages)];
}

/**
 * The description as a match row shows it: whitespace folded to single
 * spaces, cut at a word boundary under {@link PLAYBOOK_DESCRIPTION_CAP} with
 * "…". `undefined` when there is none, so a row without one carries no key.
 */
export function playbookDescriptionPreview(
  description: string | null | undefined
): string | undefined {
  const text = (description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= PLAYBOOK_DESCRIPTION_CAP) return text;
  const cut = text.slice(0, PLAYBOOK_DESCRIPTION_CAP);
  const space = cut.lastIndexOf(" ");
  return `${(space > PLAYBOOK_DESCRIPTION_CAP / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
