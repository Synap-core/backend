/**
 * TEMPLATE SKILLS — the skills a space's template DECLARES (package `skills[]`).
 *
 * No rows are created here. A declared skill is a pod-wide `system/<pkg>/<stem>`
 * skill the pod already seeds (`ensure-system-skills`); a space LINKS it by
 * naming it, and the link lives in the space's brief (`onboarding.skills`),
 * written through the brief's compare-and-set door — exactly how
 * `template-rules.ts` records its rule refs one layer over.
 *
 * APPROVED ONLY, and that is the point. A declared skill that does not resolve
 * to an ACTIVE, APPROVED, pod-wide row is NOT written: a space is never told it
 * can use a skill the pod would refuse to load, and a draft never reaches a
 * model. The outcome says which of the three it was, so an author sees the
 * difference between a typo and a skill still awaiting approval.
 */

import {
  db,
  skills,
  workspaces,
  and,
  eq,
  inArray,
  isNull,
  getDb,
  eventRepository,
  WorkspaceRepository,
} from "@synap/database";
import {
  normalizeSpaceBrief,
  validateSpaceSkillDeclaration,
  type SpaceBriefSkillRef,
  type SpaceSkillMode,
} from "@synap-core/types/space-brief";

/** One declared skill that passed the shape rule, in declaration order. */
export interface TemplateSkillDecl {
  slug: string;
  mode: SpaceSkillMode;
  when?: string;
}

export type TemplateSkillStatus =
  | "linked" // resolved to an approved system skill → written to the brief
  | "invalid" // failed the shared shape rule (bad slug / unknown mode)
  | "unresolved" // no pod-wide skill has that slug
  | "unapproved" // the row exists but is not ACTIVE + APPROVED yet
  | "failed"; // the brief write lost a race; the next pass re-derives

export interface TemplateSkillOutcome {
  slug: string;
  status: TemplateSkillStatus;
  reason?: string;
}

/**
 * Every candidate row slug a declaration could name: the slug as written, plus
 * its `system/`-prefixed form. A template may write the canonical
 * `system/synap/creative-director`, or the shorter `synap/creative-director`
 * (the form `_teaching.json` keys use) — both resolve to the same row.
 *
 * NOT a suffix scan: a BARE stem (`creative-director`) does not match a nested
 * `system/<pkg>/creative-director`, because more than one package could carry
 * that stem and a silent guess would link the wrong skill. Matching is exact,
 * or exact after prefixing `system/` — nothing fuzzier.
 */
function candidateSlugs(slug: string): string[] {
  const out = new Set<string>([slug]);
  if (!slug.startsWith("system/")) out.add(`system/${slug}`);
  return [...out];
}

/** The shape rule is SHARED with the template validator — author time == install time. */
export function readTemplateSkills(raw: unknown): {
  decls: TemplateSkillDecl[];
  invalid: TemplateSkillOutcome[];
} {
  const decls: TemplateSkillDecl[] = [];
  const invalid: TemplateSkillOutcome[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return { decls, invalid };
  for (const entry of raw) {
    const reason = validateSpaceSkillDeclaration(entry);
    if (reason) {
      const slug =
        entry && typeof entry === "object" && "slug" in entry
          ? String((entry as { slug: unknown }).slug)
          : "(no slug)";
      invalid.push({ slug, status: "invalid", reason });
      continue;
    }
    const { slug, mode, when } = entry as TemplateSkillDecl;
    // Two modes for one skill is an ambiguous declaration, not a merge — the
    // template validator rejects it at author time; ignore the repeat here.
    if (seen.has(slug)) continue;
    seen.add(slug);
    decls.push({ slug, mode, ...(when ? { when } : {}) });
  }
  return { decls, invalid };
}

/**
 * Install / converge a template's declared skills in one space. Non-fatal per
 * skill; returns one outcome per declaration. Writes the brief's skill refs
 * through the brief's compare-and-set door.
 */
export async function applyTemplateSkills(input: {
  workspaceId: string;
  userId: string;
  skills: unknown;
}): Promise<TemplateSkillOutcome[]> {
  const { decls, invalid } = readTemplateSkills(input.skills);
  if (decls.length === 0) return invalid;

  const [ws] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (!ws) throw new Error(`workspace ${input.workspaceId} not found`);
  const rawBrief = (ws.settings as Record<string, unknown> | null)?.onboarding;
  const brief = normalizeSpaceBrief(rawBrief);

  // One read for every candidate slug; decide per declaration below so an
  // "unresolved" and an "unapproved" outcome stay distinguishable.
  const wanted = [...new Set(decls.flatMap((d) => candidateSlugs(d.slug)))];
  const rows = await db
    .select({
      slug: skills.slug,
      approved: skills.approved,
      status: skills.status,
    })
    .from(skills)
    .where(
      and(
        isNull(skills.workspaceId),
        eq(skills.kind, "instruction"),
        inArray(skills.slug, wanted)
      )
    );
  const bySlug = new Map(rows.map((r) => [r.slug as string, r]));

  const outcomes: TemplateSkillOutcome[] = [...invalid];
  const linked: SpaceBriefSkillRef[] = [];
  for (const decl of decls) {
    const row = candidateSlugs(decl.slug)
      .map((s) => bySlug.get(s))
      .find(Boolean);
    if (!row) {
      outcomes.push({
        slug: decl.slug,
        status: "unresolved",
        reason: "no pod-wide skill has this slug",
      });
      continue;
    }
    if (!row.approved || row.status !== "active") {
      outcomes.push({
        slug: decl.slug,
        status: "unapproved",
        reason: `the skill exists but is ${row.approved ? row.status : "not approved"}`,
      });
      continue;
    }
    linked.push({
      slug: decl.slug,
      mode: decl.mode,
      ...(decl.when ? { when: decl.when } : {}),
    });
  }

  if (linked.length) {
    // Declaration order first, then any ref the space already had (a skill the
    // user added by hand, or one whose template entry was removed) — the same
    // "never drop a ref the owner holds" rule the rule applier follows.
    const declared = new Set(linked.map((l) => l.slug));
    const ordered: SpaceBriefSkillRef[] = [
      ...linked,
      ...(brief?.skills ?? []).filter((r) => !declared.has(r.slug)),
    ];
    const before = JSON.stringify(brief?.skills ?? []);
    if (JSON.stringify(ordered) !== before) {
      const raw =
        rawBrief && typeof rawBrief === "object"
          ? (rawBrief as Record<string, unknown>)
          : {};
      const repo = new WorkspaceRepository(await getDb(), eventRepository);
      const wrote = await repo.replaceSpaceBrief(
        input.workspaceId,
        { expected: rawBrief, brief: { ...raw, skills: ordered } },
        input.userId
      );
      if (!wrote) {
        // A concurrent brief edit won; the declarations are still in the
        // template, so the next reconcile pass re-derives them.
        for (const l of linked) {
          outcomes.push({
            slug: l.slug,
            status: "failed",
            reason: "brief changed concurrently; re-derived next pass",
          });
        }
        return outcomes;
      }
    }
    for (const l of linked) outcomes.push({ slug: l.slug, status: "linked" });
  }

  return outcomes;
}
