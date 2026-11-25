/**
 * ONE READ of the skills a playbook uses (Process wave plan 0adf8352, W2), for
 * the process read (`process-read.ts`) and the run preflight
 * (`playbook-skill-preflight.ts`). Until now each door read its own subset of
 * the four places a playbook names a skill:
 *   guidance  a `skill:<slug>` ref in the playbook's rules (0411), rendered at
 *             run time from its current, approved version;
 *   grant     a `playbook --grants--> skill` link, or a granted capability's
 *             member skill (`resolveGrantedCapabilities`);
 *   context   the "how to run this playbook" instruction skill on a
 *             `documents` edge (`loadPlaybookContextSkill`);
 *   goal      a skill named in the goal text.
 *
 * WHY THE GOAL-TEXT MATCHING STAYS. Removing it breaks a live run: "Research a
 * Question" names `source-triage` and `evidence-synthesis` in its goal and
 * grants nothing, so the preflight would let a run start that dies at the gate
 * mid-way (the founder's D3 of 2026-09-14). It is kept, with its limit: only a
 * compound name (`-`, `_`, `.`) matches, as a whole token; a one-word name
 * would collide with English. It moves the day those playbooks declare their
 * skills (`tools` / guidance), which the catalog owns.
 *
 * WHAT GATES A RUN. Only `grant` and `goal` name VERBS a run calls: a draft one
 * refuses the run (`RUN_GATING_SKILL_SOURCES`). A `guidance` or `context` skill
 * is prose: an unapproved one simply does not render (its loaders read the
 * approved version only), it never refuses a run.
 *
 * A read the pod cannot make THROWS (the caller decides: the process read
 * names `skills` unavailable, the preflight refuses as before).
 */
import {
  db,
  links,
  skills,
  and,
  desc,
  eq,
  inArray,
  or,
  drizzleSql,
} from "@synap/database";
import { parseGuidanceRef } from "@synap-core/types/guidance";
import { spaceSkillSlugCandidates } from "@synap-core/types/space-brief";
import {
  PROCESS_SKILL_SOURCES,
  type ProcessSkill,
  type ProcessSkillSource,
} from "@synap-core/types/processes";
import { visibleSkillsWhere } from "../skills/visibility.js";
import {
  getLinksFor,
  resolveGrantedCapabilities,
} from "../links/links-service.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";

/** The sources whose draft skill refuses a run (they name verbs it calls). */
export const RUN_GATING_SKILL_SOURCES: readonly ProcessSkillSource[] = [
  "grant",
  "goal",
];

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

export interface VisibleSkillRow {
  id: string;
  name: string;
  approved: boolean;
  slug?: string | null;
}

/**
 * Pure: the skills a playbook GRANTS and the ones its goal NAMES, among the
 * visible ones. A granted skill is listed whatever its state. A named one: an
 * approved row of that name wins (the execute door resolves a name to the
 * approved row first, `execute-capability.ts`); with none, each draft row of
 * that name is listed.
 */
export function selectGrantAndGoalSkills(input: {
  goalTemplate: unknown;
  grantedSkillIds: ReadonlySet<string>;
  visibleSkills: readonly VisibleSkillRow[];
}): ProcessSkill[] {
  const goal = typeof input.goalTemplate === "string" ? input.goalTemplate : "";
  const out: ProcessSkill[] = [];
  const entry = (s: VisibleSkillRow, source: ProcessSkillSource) => ({
    id: s.id,
    slug: s.slug ?? null,
    name: s.name,
    source,
    approved: s.approved,
  });
  for (const s of input.visibleSkills) {
    if (input.grantedSkillIds.has(s.id)) out.push(entry(s, "grant"));
  }
  const approvedNames = new Set(
    input.visibleSkills.filter((s) => s.approved).map((s) => s.name)
  );
  const namedSeen = new Set<string>();
  for (const s of input.visibleSkills) {
    if (!goalMentionsSkill(goal, s.name)) continue;
    if (approvedNames.has(s.name)) {
      if (!s.approved || namedSeen.has(s.name)) continue;
      namedSeen.add(s.name);
    }
    out.push(entry(s, "goal"));
  }
  return out;
}

async function readVisibleSkills(
  userId: string,
  workspaceId: string | null
): Promise<VisibleSkillRow[]> {
  return db
    .select({
      id: skills.id,
      name: skills.name,
      approved: skills.approved,
      slug: skills.slug,
    })
    .from(skills)
    .where(
      and(
        visibleSkillsWhere(userId, workspaceId ?? undefined),
        eq(skills.status, "active")
      )
    );
}

/** The skill refs of a guidance declaration, in declared order, each once. */
function guidanceSkillSlugs(guidance: unknown): string[] {
  if (!Array.isArray(guidance)) return [];
  const out: string[] = [];
  for (const item of guidance) {
    const ref = parseGuidanceRef((item as { ref?: unknown } | null)?.ref);
    if (ref?.type === "skill" && !out.includes(ref.slug)) out.push(ref.slug);
  }
  return out;
}

async function readGuidanceSkills(
  guidance: unknown,
  userId: string
): Promise<ProcessSkill[]> {
  const slugs = guidanceSkillSlugs(guidance);
  if (slugs.length === 0) return [];
  const candidates = [...new Set(slugs.flatMap(spaceSkillSlugCandidates))];
  // The guidance loader's own visibility (`playbook-guidance.ts`
  // `resolveSkill`), without its approval filter: the read says whether the
  // skill is approved, it does not hide a draft.
  const rows = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      approved: skills.approved,
    })
    .from(skills)
    .where(
      and(
        inArray(skills.slug, candidates),
        eq(skills.status, "active"),
        or(
          eq(skills.userId, userId),
          userVisibleWhere(skills.workspaceId, userId)
        )
      )
    );
  return slugs.map((slug): ProcessSkill => {
    const forSlug = rows.filter(
      (r) => r.slug !== null && spaceSkillSlugCandidates(slug).includes(r.slug)
    );
    // The ref as written wins over its `system/` form; an approved row first.
    const pick =
      forSlug.find((r) => r.slug === slug && r.approved) ??
      forSlug.find((r) => r.slug === slug) ??
      forSlug.find((r) => r.approved) ??
      forSlug[0];
    return pick
      ? {
          id: pick.id,
          slug: pick.slug,
          name: pick.name,
          source: "guidance",
          approved: pick.approved,
        }
      : { id: null, slug, name: slug, source: "guidance", approved: null };
  });
}

async function readContextSkill(playbookId: string): Promise<ProcessSkill[]> {
  // `loadPlaybookContextSkill`'s edge, without its approval filter (the read
  // says whether it is approved; the loader still renders only an approved one).
  const [row] = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      approved: skills.approved,
    })
    .from(links)
    .innerJoin(skills, eq(drizzleSql`${skills.id}::text`, links.toId))
    .where(
      and(
        eq(links.fromType, "playbook"),
        eq(links.fromId, playbookId),
        eq(links.linkType, "documents"),
        eq(links.toType, "skill"),
        eq(skills.kind, "instruction")
      )
    )
    .orderBy(desc(skills.createdAt))
    .limit(1);
  return row
    ? [
        {
          id: row.id,
          slug: row.slug,
          name: row.name,
          source: "context",
          approved: row.approved,
        },
      ]
    : [];
}

/**
 * THE read: the skills a playbook uses, one entry per (skill, source), in the
 * order guidance, grant, context, goal. `sources` narrows it (the preflight
 * reads only the run-gating ones). THROWS on a failed read.
 */
export async function readPlaybookSkills(input: {
  playbook: { id: string; goalTemplate: unknown; guidance?: unknown };
  userId: string;
  /** The lens the run lands in; `null` = a pod-wide playbook read on its own. */
  workspaceId: string | null;
  sources?: readonly ProcessSkillSource[];
}): Promise<ProcessSkill[]> {
  const want = new Set(input.sources ?? PROCESS_SKILL_SOURCES);
  const needVerbs = want.has("grant") || want.has("goal");
  const [guidance, grantedIds, visible, context] = await Promise.all([
    want.has("guidance")
      ? readGuidanceSkills(input.playbook.guidance, input.userId)
      : [],
    want.has("grant")
      ? getLinksFor(input.userId, "playbook", input.playbook.id).then(
          async (playbookLinks) =>
            new Set(
              (
                await resolveGrantedCapabilities(playbookLinks, {
                  linkType: "grants",
                  fromType: "playbook",
                })
              )
                .filter((c) => c.kind === "skill")
                .map((c) => c.id)
            )
        )
      : new Set<string>(),
    needVerbs ? readVisibleSkills(input.userId, input.workspaceId) : [],
    want.has("context") ? readContextSkill(input.playbook.id) : [],
  ]);
  const verbs = needVerbs
    ? selectGrantAndGoalSkills({
        goalTemplate: want.has("goal") ? input.playbook.goalTemplate : "",
        grantedSkillIds: grantedIds,
        visibleSkills: visible,
      })
    : [];
  return [
    ...guidance,
    ...verbs.filter((s) => s.source === "grant"),
    ...context,
    ...verbs.filter((s) => s.source === "goal"),
  ];
}
