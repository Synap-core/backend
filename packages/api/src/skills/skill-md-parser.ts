/**
 * SKILL.md Parser
 *
 * Parses the OpenClaw community skill format.
 * Format: YAML frontmatter + markdown body
 *
 * Example:
 * ---
 * name: research-analyst
 * version: 1.0.0
 * description: Meticulous research persona for deep-dive analysis
 * dependencies:
 *   - search-tools
 * ---
 * # Research Analyst
 * You are a meticulous research analyst...
 *
 * Compatible with 5,700+ skills on ClawHub.
 */

export interface ParsedSkillMd {
  name: string;
  version: string;
  description: string;
  dependencies?: string[];
  /** Full markdown body after frontmatter — injected into agent system prompt */
  instructions: string;
  source: "clawhub" | "custom";
  skillType: "instruction";
}

/**
 * Parse a SKILL.md string.
 * Returns null if the content doesn't look like a valid SKILL.md.
 */
export function parseSkillMd(content: string): ParsedSkillMd | null {
  if (!content.trim().startsWith("---")) {
    return null;
  }

  const endFrontmatter = content.indexOf("---", 3);
  if (endFrontmatter === -1) {
    return null;
  }

  const yamlPart = content.slice(3, endFrontmatter).trim();
  const body = content.slice(endFrontmatter + 3).trim();

  // Parse YAML frontmatter manually (no dependency needed for simple key: value pairs)
  const meta: Record<string, unknown> = {};
  for (const line of yamlPart.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    // Handle array values (lines starting with "  - ")
    if (value === "" || value === "|") {
      // multiline or list — skip for now, handled below
      continue;
    }
    meta[key] = value.replace(/^["']|["']$/g, ""); // strip surrounding quotes
  }

  // Handle list values (name: then "  - item" on subsequent lines)
  const listMatches = yamlPart.matchAll(
    /^(\w[\w-]*):\s*\n((?:\s+-\s+.+\n?)+)/gm
  );
  for (const match of listMatches) {
    const key = match[1];
    const items = match[2]
      .split("\n")
      .map((l) => l.replace(/^\s+-\s+/, "").trim())
      .filter(Boolean);
    meta[key] = items;
  }

  const name = meta.name as string | undefined;
  if (!name) return null;

  return {
    name: slugify(name),
    version: (meta.version as string) || "1.0.0",
    description: (meta.description as string) || name,
    dependencies: Array.isArray(meta.dependencies)
      ? (meta.dependencies as string[])
      : undefined,
    instructions: body,
    source: "clawhub",
    skillType: "instruction",
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
