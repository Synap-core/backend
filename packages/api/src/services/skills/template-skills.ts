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
  drizzleSql,
  or,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  alwaysSkillBudgetWarning,
  alwaysSkillOverBudget,
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
  /**
   * A non-fatal authoring problem with a LINKED skill — today, an `always`
   * skill whose body is over the per-skill budget, so the IS will load it on
   * demand instead of every turn. A warning, never a refusal: the link stands.
   */
  warning?: string;
}

const logger = createLogger({ module: "template-skills" });

/**
 * The spaces whose brief links a skill ROW `mode: "always"` — by any spelling a
 * template may have declared it with (`system/a/b` or `a/b`, the inverse of
 * {@link candidateSlugs}). For a warning when that row's body changes.
 */
export async function spacesLinkingAlways(
  rowSlug: string
): Promise<Array<{ id: string; name: string }>> {
  const declared = rowSlug.startsWith("system/")
    ? [rowSlug, rowSlug.slice("system/".length)]
    : [rowSlug];
  return db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(
      or(
        ...declared.map(
          (slug) =>
            drizzleSql`${workspaces.settings} @> ${JSON.stringify({
              onboarding: { skills: [{ slug, mode: "always" }] },
            })}::jsonb`
        )
      )
    );
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
export function candidateSlugs(slug: string): string[] {
  const out = new Set<string>([slug]);
  if (!slug.startsWith("system/")) out.add(`system/${slug}`);
  return [...out];
}

/**
 * The row slugs a space's brief LINKS — every declared ref expanded to the
 * candidate row spellings, so a ranker can match a declared
 * `synap/creative-director` against the row `system/synap/creative-director`.
 * The ONE expansion of a brief skill ref; `searchInstructionSkills` uses it to
 * rank a space's own skills first.
 */
export function linkedRowSlugs(
  refs: ReadonlyArray<{ slug: string }> | undefined
): string[] {
  return [...new Set((refs ?? []).flatMap((r) => candidateSlugs(r.slug)))];
}

/**
 * After a skill's BODY changes: one warning per space that links it
 * `mode: "always"` when the new body is over the per-skill budget. Logged here;
 * returned for the caller. Never throws — a warning must not fail the edit, and
 * a failed lookup is logged as a failed lookup, not as "no spaces".
 */
export async function alwaysSkillBudgetWarningsOnEdit(
  rowSlug: string | null | undefined,
  body: string | null | undefined
): Promise<string[]> {
  const over = alwaysSkillOverBudget(body);
  if (!rowSlug || !over) return [];
  try {
    const spaces = await spacesLinkingAlways(rowSlug);
    return spaces.map((ws) => {
      const warning = `${alwaysSkillBudgetWarning(rowSlug, over)} in "${ws.name}"`;
      logger.warn({ workspaceId: ws.id, slug: rowSlug, ...over }, warning);
      return warning;
    });
  } catch (err) {
    logger.warn(
      { err, slug: rowSlug },
      "could not check which spaces link this skill as always-on — budget warning skipped"
    );
    return [];
  }
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
      body: skills.body,
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
  const warnings = new Map<string, string>();
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
    const over =
      decl.mode === "always" ? alwaysSkillOverBudget(row.body) : null;
    if (over) {
      const warning = alwaysSkillBudgetWarning(decl.slug, over);
      warnings.set(decl.slug, warning);
      logger.warn(
        { workspaceId: input.workspaceId, slug: decl.slug, ...over },
        warning
      );
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
    for (const l of linked) {
      const warning = warnings.get(l.slug);
      outcomes.push({
        slug: l.slug,
        status: "linked",
        ...(warning ? { warning } : {}),
      });
    }
  }

  return outcomes;
}
