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
 * A playbook references a skill in two ways, and both are read:
 *   1. `grants` links — to a skill, or to a capability container (expanded to
 *      its members by `resolveGrantedCapabilities`). Matched by id.
 *   2. The goal prose — live playbooks name skills in `goalTemplate` and grant
 *      nothing. Matched by name, as a whole token.
 *
 * LIMIT (prose matching): only compound names — containing `-`, `_` or `.` —
 * are matched in prose. A one-word skill name ("research") collides with
 * ordinary English and would refuse runs that never use it; such a skill is
 * still caught when it is granted. A name with an ENABLED visible twin is not
 * reported: the execute door resolves a name to the approved row first
 * (`execute-capability.ts`, `orderBy(desc(skills.approved))`).
 */

import { db, skills, and, eq } from "@synap/database";
import { visibleSkillsWhere } from "../skills/visibility.js";
import {
  getLinksFor,
  resolveGrantedCapabilities,
} from "../links/links-service.js";
import type { SkillRef } from "../capabilities/propose-capability-enable.js";
import { openLink, openTypedLink } from "../../utils/deep-links.js";

const COMPOUND_NAME = /[-_.]/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pure: is `name` written in `goal` as a whole token (not inside a longer identifier)? */
export function goalMentionsSkill(goal: string, name: string): boolean {
  if (!COMPOUND_NAME.test(name)) return false;
  return new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w-]|\\.\\w)`).test(
    goal
  );
}

/** Pure: the draft skills a playbook depends on, sorted by name. */
export function selectUnenabledPlaybookSkills(input: {
  goalTemplate: unknown;
  grantedSkillIds: ReadonlySet<string>;
  visibleSkills: ReadonlyArray<{ id: string; name: string; approved: boolean }>;
}): SkillRef[] {
  const goal = typeof input.goalTemplate === "string" ? input.goalTemplate : "";
  const enabledNames = new Set(
    input.visibleSkills.filter((s) => s.approved).map((s) => s.name)
  );
  const found = new Map<string, SkillRef>();
  for (const s of input.visibleSkills) {
    if (s.approved) continue;
    const granted = input.grantedSkillIds.has(s.id);
    const named = !enabledNames.has(s.name) && goalMentionsSkill(goal, s.name);
    if (granted || named) found.set(s.id, { id: s.id, name: s.name });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function findUnenabledPlaybookSkills(input: {
  playbook: { id: string; goalTemplate: unknown };
  userId: string;
  /** The lens the run lands in; `null` = a pod-wide playbook read on its own. */
  workspaceId: string | null;
}): Promise<SkillRef[]> {
  const playbookLinks = await getLinksFor(
    input.userId,
    "playbook",
    input.playbook.id
  );
  const granted = await resolveGrantedCapabilities(playbookLinks, {
    linkType: "grants",
    fromType: "playbook",
  });
  const visibleSkills = await db
    .select({ id: skills.id, name: skills.name, approved: skills.approved })
    .from(skills)
    .where(
      and(
        visibleSkillsWhere(input.userId, input.workspaceId ?? undefined),
        eq(skills.status, "active")
      )
    );
  return selectUnenabledPlaybookSkills({
    goalTemplate: input.playbook.goalTemplate,
    grantedSkillIds: new Set(
      granted.filter((c) => c.kind === "skill").map((c) => c.id)
    ),
    visibleSkills,
  });
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
