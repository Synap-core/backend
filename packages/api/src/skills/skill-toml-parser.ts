/**
 * SKILL.toml Parser
 *
 * Parses the ZeroClaw skill manifest format.
 * Format: TOML metadata file + companion markdown instructions.
 *
 * Example SKILL.toml:
 * [skill]
 * name = "code-reviewer"
 * version = "1.0.0"
 * description = "Senior code reviewer persona"
 *
 * [dependencies]
 * tools = ["search-docs"]
 *
 * The companion markdown is either provided inline via `instructions` key
 * or loaded from a companion .md file (not handled here — caller provides the body).
 */

export interface ParsedSkillToml {
  name: string;
  version: string;
  description: string;
  dependencies?: string[];
  instructions: string;
  source: "zeroclaw" | "custom";
  skillType: "instruction";
}

/**
 * Parse a SKILL.toml string, optionally with separate markdown body.
 * Returns null if the content doesn't look like a valid SKILL.toml.
 */
export function parseSkillToml(
  tomlContent: string,
  markdownBody?: string
): ParsedSkillToml | null {
  // Very simple TOML parser — handles [section] and key = "value" patterns
  const meta: Record<string, string | string[]> = {};
  let currentSection = "";

  for (const rawLine of tomlContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Section header: [skill] or [dependencies]
    const sectionMatch = line.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      continue;
    }

    // Array value: tools = ["a", "b"]
    const arrayMatch = line.match(/^(\w+)\s*=\s*\[(.+)\]$/);
    if (arrayMatch) {
      const key = `${currentSection}.${arrayMatch[1]}`;
      const values = arrayMatch[2]
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      meta[key] = values;
      continue;
    }

    // String value: key = "value" or key = value
    const keyValueMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (keyValueMatch) {
      const key = `${currentSection}.${keyValueMatch[1]}`;
      meta[key] = keyValueMatch[2].trim().replace(/^["']|["']$/g, "");
    }
  }

  const name = meta["skill.name"] as string | undefined;
  if (!name) return null;

  // Instructions from inline field or separate markdown body
  const instructions =
    markdownBody?.trim() ||
    (meta["skill.instructions"] as string) ||
    (meta["instructions"] as string) ||
    "";

  return {
    name: slugify(name),
    version: (meta["skill.version"] as string) || "1.0.0",
    description: (meta["skill.description"] as string) || name,
    dependencies: Array.isArray(meta["dependencies.tools"])
      ? (meta["dependencies.tools"] as string[])
      : undefined,
    instructions,
    source: "zeroclaw",
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
