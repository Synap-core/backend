/**
 * What a package installs beyond its schema — the playbooks, automations
 * (with the status each asks for), capabilities and MCP servers — as a small
 * list a proposal card can show. ONE derivation, stored on every gated
 * install/update proposal as `data.contents`, so the person approving a
 * template sees layer 2 instead of only a space name.
 *
 * Derived from the definition FILED with the proposal (the agent's body).
 * A capability referenced by `templateKey` is listed by key only: its own
 * MCP servers live in the template, not in this body, so `mcpServers` covers
 * inline capability definitions. Strings are clipped; nothing secret is read
 * (no `env`, no vault values).
 */

const MAX_ITEMS = 50;
const MAX_TEXT = 200;

export interface PackageContentsSummary {
  playbooks: Array<{ name: string }>;
  automations: Array<{ name: string; status: string; triggerType?: string }>;
  capabilities: Array<{
    key: string;
    name?: string;
    source: "template" | "inline";
  }>;
  mcpServers: Array<{
    slug?: string;
    name?: string;
    transport?: string;
    url?: string;
    command?: string;
    capabilityKey?: string;
  }>;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim()
    ? v.trim().slice(0, MAX_TEXT)
    : undefined;
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v
        .filter(
          (x): x is Record<string, unknown> =>
            !!x && typeof x === "object" && !Array.isArray(x)
        )
        .slice(0, MAX_ITEMS)
    : [];
}

/** Undefined keys dropped, so the stored JSON reads exactly what is known. */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined)
  ) as T;
}

export function summarizePackageContents(
  definition: unknown
): PackageContentsSummary {
  const def =
    definition && typeof definition === "object"
      ? (definition as Record<string, unknown>)
      : {};
  const summary: PackageContentsSummary = {
    playbooks: [],
    automations: [],
    capabilities: [],
    mcpServers: [],
  };
  for (const p of records(def.playbooks)) {
    const name = text(p.name);
    if (name) summary.playbooks.push({ name });
  }
  for (const a of records(def.automations)) {
    const name = text(a.name);
    if (!name) continue;
    summary.automations.push(
      compact({
        name,
        // The apply door's schema defaults an absent status to `active`.
        status: text(a.status) ?? "active",
        triggerType: text(a.triggerType),
      })
    );
  }
  for (const c of records(def.capabilities)) {
    const inline =
      c.definition && typeof c.definition === "object"
        ? (c.definition as Record<string, unknown>)
        : undefined;
    const key = text(inline?.key) ?? text(c.templateKey);
    if (!key) continue;
    summary.capabilities.push(
      compact({
        key,
        name: text(inline?.name),
        source: inline ? ("inline" as const) : ("template" as const),
      })
    );
    for (const m of records(inline?.mcpServers)) {
      summary.mcpServers.push(
        compact({
          slug: text(m.slug),
          name: text(m.name),
          transport: text(m.transport),
          url: text(m.url),
          command: text(m.command),
          capabilityKey: key,
        })
      );
    }
  }
  return summary;
}
