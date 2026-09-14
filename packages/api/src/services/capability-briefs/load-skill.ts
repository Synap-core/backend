/**
 * loadSkill (AI Teaching Substrate Wave 2b) — the L2 tier behind the MCP
 * `synap_load_skill` tool. Composed briefs (`compose-capability-brief.ts`) are
 * the L1/proactive layer (summary + pointer); this is what the pointer
 * resolves to — the full seeded skill body, fetched on demand.
 *
 * `ref` accepts:
 *   - `"catalog"` — the L1 catalog: one `slug — description` line per system
 *     skill, grouped by `skillGroup`.
 *   - a full `system/<package>/<stem>` slug, a bare stem (`document-embeds`),
 *     or any other instruction skill's own slug.
 *
 * VISIBILITY is the ONE skill predicate, `visibleSkillsWhere` — the same lens
 * as `GET /api/hub/agent-skills` and `skills.list`: pod skills, the caller's
 * own user skills, and the selected workspace's skills when the caller can see
 * that workspace. Rule expiry is ENFORCED (no `includeExpired`) — this door
 * feeds an agent's context.
 */

import { and, asc, eq, inArray, or } from "drizzle-orm";
import { db, drizzleSql, skills } from "@synap/database";
import { escapeLike } from "../../utils/term-match.js";
import { visibleSkillsWhere } from "../skills/visibility.js";

export interface SkillLensOptions {
  /** Include this workspace's skills (membership is checked by the predicate). */
  workspaceId?: string;
}

/**
 * Every servable gate, in one place, so the catalog never advertises a skill
 * the resolver would then refuse to hand over.
 */
function servableSkillsWhere(userId: string, options?: SkillLensOptions) {
  return and(
    visibleSkillsWhere(userId, options?.workspaceId),
    eq(skills.kind, "instruction"),
    eq(skills.status, "active"),
    eq(skills.approved, true)
  );
}

/**
 * @param userId Caller — the lens is theirs. A catalog that hides skills the
 *   caller may use makes them unfindable in practice: an agent that cannot see
 *   a skill never thinks to load it.
 */
export async function loadSkillCatalog(
  userId: string,
  options?: SkillLensOptions
): Promise<string> {
  const rows = await db
    .select({
      slug: skills.slug,
      description: skills.description,
      skillGroup: skills.skillGroup,
      userId: skills.userId,
      scope: skills.scope,
    })
    .from(skills)
    .where(servableSkillsWhere(userId, options));

  const byGroup = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.slug) continue; // unreachable by ref → never advertise it
    const isSystem = r.slug.startsWith("system/");
    const group = isSystem
      ? (r.skillGroup ?? "core")
      : r.scope === "workspace"
        ? "workspace"
        : r.userId === userId
          ? "yours"
          : "shared";
    const line = `${r.slug} — ${r.description ?? r.slug}`;
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push(line);
  }

  const groups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  return groups
    .map(([group, lines]) => `## ${group}\n${lines.sort().join("\n")}`)
    .join("\n\n");
}

export async function resolveSkillContent(
  ref: string,
  userId: string,
  options?: SkillLensOptions
): Promise<string> {
  if (ref === "catalog") return loadSkillCatalog(userId, options);

  // Seeded slugs have no extension (`ensureSystemSkills` strips it), but the
  // always-on session instructions spliced from `skills/synap/reflexes.md` refer
  // to siblings BY FILENAME — "Full detail: `escalation-ladder.md`", "see
  // `writes.md`", "`inline-patterns.md`". Without this strip those pointers
  // resolve to nothing and the agent burns a turn on "No skill found matching…"
  // — a dangling pointer in ambient instructions is worse than no pointer.
  const stem = ref.replace(/\.md$/i, "");
  const candidates = stem.startsWith("system/")
    ? [stem]
    : [stem, `system/${stem}`];

  // `ref` is agent input: `%`/`_` are literal, so "%" cannot load an arbitrary
  // visible skill through the suffix match.
  const suffix = `%/${escapeLike(stem)}`;
  const [row] = await db
    .select({ slug: skills.slug, body: skills.body, name: skills.name })
    .from(skills)
    .where(
      and(
        servableSkillsWhere(userId, options),
        or(
          inArray(skills.slug, candidates),
          drizzleSql`${skills.slug} LIKE ${suffix} ESCAPE '\\'`
        )
      )
    )
    // Seeded text first: a `system/*` match outranks everything, so a pod skill
    // named after a system stem ("writes") can never shadow the pointers every
    // session's instructions carry. Then the exact slug, then other suffix
    // matches by slug, id.
    .orderBy(
      drizzleSql`CASE WHEN ${skills.slug} LIKE 'system/%' THEN 0 WHEN ${skills.slug} = ${stem} THEN 1 ELSE 2 END`,
      asc(skills.slug),
      asc(skills.id)
    )
    .limit(1);

  if (!row || !row.body) {
    return `No skill found matching "${ref}". Call synap_load_skill("catalog") to see what's available.`;
  }
  return row.body;
}
