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
 *     or any user-authored instruction skill's own slug — same visibility as
 *     the existing skills-list doors: pod-wide system rows, or a row owned by
 *     the calling user.
 */

import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { db, skills } from "@synap/database";

export async function loadSkillCatalog(): Promise<string> {
  const rows = await db
    .select({
      slug: skills.slug,
      description: skills.description,
      skillGroup: skills.skillGroup,
    })
    .from(skills)
    .where(
      and(
        eq(skills.kind, "instruction"),
        isNull(skills.workspaceId),
        like(skills.slug, "system/%")
      )
    );

  const byGroup = new Map<string, string[]>();
  for (const r of rows) {
    const group = r.skillGroup ?? "core";
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
  userId: string
): Promise<string> {
  if (ref === "catalog") return loadSkillCatalog();

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

  const [row] = await db
    .select({ slug: skills.slug, body: skills.body, name: skills.name })
    .from(skills)
    .where(
      and(
        eq(skills.kind, "instruction"),
        eq(skills.status, "active"),
        eq(skills.approved, true),
        or(inArray(skills.slug, candidates), like(skills.slug, `%/${stem}`)),
        or(isNull(skills.workspaceId), eq(skills.userId, userId))
      )
    )
    .limit(1);

  if (!row || !row.body) {
    return `No skill found matching "${ref}". Call synap_load_skill("catalog") to see what's available.`;
  }
  return row.body;
}
