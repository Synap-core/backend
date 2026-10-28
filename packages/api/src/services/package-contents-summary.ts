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
 *
 * The setup review (onboarding A6) reads four more lists off the same body:
 * the `spaces` it creates (itself + its `require` dependencies), the `kinds`
 * and `views` it declares, and what it `waitsOn` (a capability that needs a
 * connection). What a capability needs is read from its DEFINITION, which a
 * `templateKey` entry does not carry: the caller hands it in `context`
 * (`proposeTemplateApply` reads the pod's catalog cache). A capability whose
 * definition was not read is listed in `waitsOnUnread`, never as "needs
 * nothing": an unread requirement and no requirement are different facts.
 */

const MAX_ITEMS = 50;
const MAX_TEXT = 200;

/** What one capability needs connected before it can run. */
export interface ConnectionNeed {
  kind: "provider" | "vault";
  /** The OAuth provider (`nango://<provider>`), for a provider connection. */
  provider?: string;
}

export interface PackageContentsContext {
  /**
   * Per capability key: what it needs connected (`null` = nothing), derived
   * from its definition. A key absent here was NOT read.
   */
  connections?: ReadonlyMap<
    string,
    (ConnectionNeed & { name?: string }) | null
  >;
  /** Display names of dependency spaces, by template slug. */
  spaceNames?: ReadonlyMap<string, string>;
}

export interface PackageContentsSummary {
  /** The spaces approving creates: this template, then what it requires. */
  spaces: Array<{
    slug?: string;
    name?: string;
    role: "self" | "dependency";
    /** Why a dependency is needed (the template's own words). */
    reason?: string;
  }>;
  kinds: Array<{ slug: string; name?: string }>;
  views: Array<{
    name: string;
    slug?: string;
    type?: string;
    profile?: string;
    /** The view the space opens on (`defaultView`). */
    default: boolean;
  }>;
  /** Capabilities that need a connection before they run. */
  waitsOn: Array<{ key: string; name?: string } & ConnectionNeed>;
  /** Capabilities whose requirement could not be read (never "none"). */
  waitsOnUnread: string[];
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

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * The capability key an entry of `capabilities[]` names: its inline
 * definition's `key`, else its `templateKey`. Shared with the resolver that
 * builds `context.connections`, so the two always key alike.
 */
export function packageCapabilityKey(entry: unknown): string | undefined {
  const c = obj(entry);
  return text(obj(c?.definition)?.key) ?? text(c?.templateKey);
}

export function summarizePackageContents(
  definition: unknown,
  context: PackageContentsContext = {}
): PackageContentsSummary {
  const def = obj(definition) ?? {};
  const summary: PackageContentsSummary = {
    spaces: [],
    kinds: [],
    views: [],
    waitsOn: [],
    waitsOnUnread: [],
    playbooks: [],
    automations: [],
    capabilities: [],
    mcpServers: [],
  };
  const self = compact({
    slug: text(obj(def._meta)?.slug),
    name: text(def.workspaceName),
    role: "self" as const,
  });
  if (self.slug || self.name) summary.spaces.push(self);
  for (const d of records(def.dependencies)) {
    const slug = text(d.slug);
    // A `compose` base is layered onto, and a non-workspace dependency is no
    // space: only a required workspace is a space this approval creates.
    if (!slug || (text(d.kind) ?? "workspace") !== "workspace") continue;
    if ((text(d.relation) ?? "require") !== "require") continue;
    summary.spaces.push(
      compact({
        slug,
        name: context.spaceNames?.get(slug),
        role: "dependency" as const,
        reason: text(d.reason),
      })
    );
  }
  for (const p of records(def.profiles)) {
    const slug = text(p.slug);
    if (slug)
      summary.kinds.push(
        compact({ slug, name: text(p.displayName) ?? text(p.name) })
      );
  }
  for (const v of records(def.views)) {
    const name = text(v.name);
    if (!name) continue;
    // The create core merges top-level view fields under `config`, and
    // `config` wins (create-workspace-from-definition, viewConfigExtra).
    const flag = obj(v.config)?.defaultView ?? v.defaultView;
    summary.views.push(
      compact({
        name,
        slug: text(v.slug),
        type: text(v.type),
        profile: text(v.scopeProfileSlug),
        default: flag === true,
      })
    );
  }
  for (const c of records(def.capabilities)) {
    const key = packageCapabilityKey(c);
    if (!key) continue;
    const need = context.connections?.get(key);
    if (need === undefined) summary.waitsOnUnread.push(key);
    else if (need)
      summary.waitsOn.push(
        compact({
          key,
          ...need,
          name: text(need.name) ?? text(obj(c.definition)?.name),
        })
      );
  }
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
