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

/**
 * @param userId Caller — their OWN authored teaching skills are listed
 *   alongside the seeded `system/*` ones. Omitting it lists system skills only.
 *   A catalog that hides user-authored skills makes them unfindable in
 *   practice: an agent that cannot see a skill never thinks to load it, so the
 *   authoring door would be built and severed at the discovery step.
 */
export async function loadSkillCatalog(userId?: string): Promise<string> {
  const rows = await db
    .select({
      slug: skills.slug,
      description: skills.description,
      skillGroup: skills.skillGroup,
      userId: skills.userId,
    })
    .from(skills)
    .where(
      and(
        eq(skills.kind, "instruction"),
        eq(skills.status, "active"),
        // Same approval floor `resolveSkillContent` enforces — never advertise
        // a skill the resolver would then refuse to hand over.
        eq(skills.approved, true),
        userId
          ? or(
              and(isNull(skills.workspaceId), like(skills.slug, "system/%")),
              eq(skills.userId, userId)
            )
          : and(isNull(skills.workspaceId), like(skills.slug, "system/%"))
      )
    );

  const byGroup = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.slug) continue; // unreachable by ref → never advertise it
    const isSystem = r.slug.startsWith("system/");
    const group = isSystem ? (r.skillGroup ?? "core") : "yours";
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
  if (ref === "catalog") return loadSkillCatalog(userId);

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
