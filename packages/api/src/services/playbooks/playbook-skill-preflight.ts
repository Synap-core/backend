/**
 * Playbook skill preflight — which skills a playbook depends on that are
 * installed but NOT enabled, found BEFORE the run launches (founder decision
 * D3, 2026-09-14).
 *
 * Without it, a run starts, the agent reaches the draft skill mid-run, the gate
 * refuses, and the session dies half-done. "Research a Question" is the live
 * case: its goal says "Use the source-triage skill …" and research-methods is
 * installed with zero enabled verbs.
 *
 * WHICH skills: the run-gating half of the ONE read of a playbook's skills
 * (`readPlaybookSkills`, `playbook-skills.ts`, Process wave W2): the ones it
 * GRANTS (a `grants` link to a skill, or a granted capability's members), and
 * the ones its goal NAMES (compound names only, as a whole token; a name with
 * an ENABLED visible twin is not reported: the execute door resolves a name to
 * the approved row first). Guidance and context skills are prose, never
 * gating: an unapproved one just does not render.
 */

import type { SkillRef } from "../capabilities/propose-capability-enable.js";
import { openLink, openTypedLink } from "../../utils/deep-links.js";
import {
  RUN_GATING_SKILL_SOURCES,
  readPlaybookSkills,
  selectGrantAndGoalSkills,
  type VisibleSkillRow,
} from "./playbook-skills.js";

export { goalMentionsSkill } from "./playbook-skills.js";

/** Pure: the draft skills among a playbook's run-gating skills, each once, sorted by name. */
function draftsOf(
  entries: ReadonlyArray<{
    id: string | null;
    name: string;
    approved: boolean | null;
  }>
): SkillRef[] {
  const found = new Map<string, SkillRef>();
  for (const s of entries) {
    if (s.approved === false && s.id)
      found.set(s.id, { id: s.id, name: s.name });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pure: the draft skills a playbook depends on, sorted by name. */
export function selectUnenabledPlaybookSkills(input: {
  goalTemplate: unknown;
  grantedSkillIds: ReadonlySet<string>;
  visibleSkills: readonly VisibleSkillRow[];
}): SkillRef[] {
  return draftsOf(selectGrantAndGoalSkills(input));
}

export async function findUnenabledPlaybookSkills(input: {
  playbook: { id: string; goalTemplate: unknown };
  userId: string;
  /** The lens the run lands in; `null` = a pod-wide playbook read on its own. */
  workspaceId: string | null;
}): Promise<SkillRef[]> {
  return draftsOf(
    await readPlaybookSkills({ ...input, sources: RUN_GATING_SKILL_SOURCES })
  );
}

/** One pack (or lone skill) a playbook needs turned on, and where a person does it. */
export interface DisabledSkillGroup {
  pack: { id: string; name: string } | null;
  skills: SkillRef[];
  /** The capability card where a person enables the pack (or the skill's own page). */
  enableLink: string;
}

/**
 * READ-ONLY readiness — the same detection the run doors refuse on
 * ({@link findUnenabledPlaybookSkills}), grouped by pack with the card that
 * enables it. Files nothing: it is what `diagnose` answers, so "why did this
 * run not start?" names the skills that are off without waiting for a run.
 */
export async function readPlaybookSkillReadiness(input: {
  playbook: { id: string; goalTemplate: unknown };
  userId: string;
  workspaceId: string | null;
}): Promise<{ ready: boolean; disabled: DisabledSkillGroup[] }> {
  const unenabled = await findUnenabledPlaybookSkills(input);
  if (unenabled.length === 0) return { ready: true, disabled: [] };
  const { loadContainerRefs, containerMemberKey } =
    await import("../capabilities/capability-registry.js");
  const refs = await loadContainerRefs({
    toolIds: [],
    skillIds: unenabled.map((s) => s.id),
    userId: input.userId,
  });
  const groups = new Map<string, DisabledSkillGroup>();
  for (const skill of unenabled) {
    const ref = refs.get(containerMemberKey("skill", skill.id));
    const key = ref ? `capability:${ref.id}` : `skill:${skill.id}`;
    const group = groups.get(key) ?? {
      pack: ref ? { id: ref.id, name: ref.name } : null,
      skills: [],
      enableLink: ref
        ? openTypedLink("capability", ref.id)
        : openLink(skill.id),
    };
    group.skills.push(skill);
    groups.set(key, group);
  }
  return { ready: false, disabled: [...groups.values()] };
}
