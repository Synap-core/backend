/**
 * Object KINDS — THE single source of truth for object IDENTITY.
 *
 * This is the DATA half of `@synap-core/object-registry`, relocated here so
 * that ONE table serves both repos. The backend cannot import a synap-app
 * workspace package, and the two used to be kept in step by a drift test — a
 * fork waiting to happen (and it happened once: `focus_session` was "Focus
 * session" here and "Session" there). `@synap-core/object-registry` now
 * RE-EXPORTS everything below, so its ~41 importers are unaffected; the React
 * renderers (`react.tsx`) and altitude helpers (`altitudes.tsx`) stay there
 * because they are UI-coupled.
 *
 * It answers, for ANY object kind:
 *
 * (entity of any profile, view, document, channel, project, session, workspace,
 * widget/cell, or a system capability — skill, automation, playbook,
 * capability, command, tool, agent — plus proposals/notifications):
 *
 *   • what ICON represents this kind?   (a Lucide icon NAME, resolved lazily)
 *   • what COLOR does it read as?        (a `--synap-identity-*` TOKEN, never hex)
 *   • what LABEL do we call it?          (singular + plural)
 *   • (dense chips) what GLYPH?          (an optional compact char)
 *
 * This REPLACES the ~14 hand-rolled `kind → icon/color/label` maps that had
 * drifted across chips, mention menus, context pills, capture, badges and
 * per-app copies (e.g. `person` was cyan in a card but teal in a graph). It is
 * a zero-dependency DATA leaf so every surface — however light — can import it
 * without pulling React or the heavy entity-card stack. React renderers live in
 * the `@synap-core/object-registry/react` entry.
 *
 * Identity is resolved as: a STATIC default for the kind, OVERLAID by the
 * object's own profile `uiHints` when available — so a surface holding only a
 * bare `type: string` and a surface holding the full profile resolve to the
 * SAME answer (`resolveObjectIdentity`). User-defined profiles, which have
 * identity ONLY via `uiHints`, are therefore first-class.
 */

// ─── Taxonomy ────────────────────────────────────────────────────────────────

/**
 * The category an object kind belongs to. Orthogonal to the entity PROFILE:
 * every entity profile (task/person/deal/…) is `category: "entity"`; the other
 * categories are the non-entity object families the UI also renders.
 */
export type ObjectCategory =
  | "entity"
  | "view"
  | "widget"
  | "cell"
  | "channel"
  | "document"
  | "project"
  | "session"
  | "workspace"
  | "skill"
  | "automation"
  | "playbook"
  | "capability"
  | "command"
  | "tool"
  | "agent"
  | "proposal"
  | "notification"
  | "run"
  | "source"
  | "participant";

/** One canonical identity entry. Colors are TOKENS, icons are NAMES. */
export interface ObjectKindDef {
  /** The kind key — a profile slug ("task", "person", <custom>) or a category-name ("view"). */
  kind: string;
  category: ObjectCategory;
  /** Lucide icon NAME (PascalCase or kebab both resolve) — never a bound component. */
  icon: string;
  /** A `--synap-identity-*` token (or `--synap-ai` for agents), wrapped in `var()`. Never hex. */
  color: string;
  label: string;
  labelPlural: string;
  /** Optional compact char for the densest inline chips (fallback when no icon fits). */
  glyph?: string;
}

/** How many categorical identity hues exist (`--synap-identity-1..N`, themed). */
export const IDENTITY_SLOT_COUNT = 12;
type IdentitySlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
/** The identity-scale tokens (12 earthy categorical hues, themed dark+light). */
const ID = (n: IdentitySlot) => `var(--synap-identity-${n})`;
/** AI/agent is ALWAYS emerald — never a categorical identity hue. */
const AI = "var(--synap-ai)";
/** Neutral fallback for unknown/untyped objects. */
export const FALLBACK_COLOR = "var(--synap-muted)";
export const FALLBACK_ICON = "Box";

/**
 * Deterministic kind → identity slot (1..N). The SAME pattern the chat identity
 * palette uses for people (`identitySlotForId`): a stable string hash into the
 * categorical scale. So any kind WITHOUT a hand-assigned semantic hue — a custom
 * profile, a system kind we haven't curated — still gets a consistent, distinct
 * color instead of collapsing to neutral grey. Same kind → same color, always.
 */
export function identitySlotForKind(kind: string): number {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (h * 31 + kind.charCodeAt(i)) >>> 0;
  return (h % IDENTITY_SLOT_COUNT) + 1;
}
/** A `--synap-identity-N` token for slot n, wrapped in `var()` (n clamped to the valid range). */
export const identityToken = (n: number): string =>
  `var(--synap-identity-${((Math.abs(Math.trunc(n)) - 1) % IDENTITY_SLOT_COUNT) + 1})`;

// ─── The registry ────────────────────────────────────────────────────────────

/**
 * Seeded from the union of the former sources (ENTITY_CONFIG icons/labels +
 * entity-accent identity tokens + the composer's system-kind maps). Color tokens
 * mirror the CANONICAL `entity-accent` choices (the token source), NOT the old
 * hex `ENTITY_CONFIG` — so this registry ends the person-cyan-vs-teal split.
 */
export const OBJECT_KINDS: Record<string, ObjectKindDef> = {
  // ── Entity profiles (category: entity) ──
  task: {
    kind: "task",
    category: "entity",
    icon: "CheckSquare",
    color: ID(1),
    label: "Task",
    labelPlural: "Tasks",
  },
  note: {
    kind: "note",
    category: "entity",
    icon: "FileText",
    color: ID(4),
    label: "Note",
    labelPlural: "Notes",
    glyph: "▤",
  },
  person: {
    kind: "person",
    category: "entity",
    icon: "User",
    color: ID(2),
    label: "Person",
    labelPlural: "People",
  },
  contact: {
    kind: "contact",
    category: "entity",
    icon: "UserCheck",
    color: ID(3),
    label: "Contact",
    labelPlural: "Contacts",
  },
  company: {
    kind: "company",
    category: "entity",
    icon: "Building2",
    color: ID(6),
    label: "Company",
    labelPlural: "Companies",
  },
  deal: {
    kind: "deal",
    category: "entity",
    icon: "TrendingUp",
    color: ID(7),
    label: "Deal",
    labelPlural: "Deals",
  },
  // `client` is a ROLE/facet, not a primary kind — but legacy views color it, so
  // it keeps an identity entry (matching the former entity-accent `identity-4`).
  client: {
    kind: "client",
    category: "entity",
    icon: "Handshake",
    color: ID(4),
    label: "Client",
    labelPlural: "Clients",
  },
  event: {
    kind: "event",
    category: "entity",
    icon: "Calendar",
    color: ID(3),
    label: "Event",
    labelPlural: "Events",
  },
  meeting: {
    kind: "meeting",
    category: "entity",
    icon: "Calendar",
    color: ID(3),
    label: "Meeting",
    labelPlural: "Meetings",
  },
  file: {
    kind: "file",
    category: "entity",
    icon: "Image",
    color: ID(10),
    label: "File",
    labelPlural: "Files",
  },
  code: {
    kind: "code",
    category: "entity",
    icon: "Code",
    color: ID(11),
    label: "Code",
    labelPlural: "Code",
  },
  bookmark: {
    kind: "bookmark",
    category: "entity",
    icon: "Bookmark",
    color: ID(12),
    label: "Bookmark",
    labelPlural: "Bookmarks",
  },
  website: {
    kind: "website",
    category: "entity",
    icon: "Globe",
    color: ID(9),
    label: "Website",
    labelPlural: "Websites",
  },
  article: {
    kind: "article",
    category: "entity",
    icon: "Newspaper",
    color: ID(8),
    label: "Article",
    labelPlural: "Articles",
  },
  capture: {
    kind: "capture",
    category: "entity",
    icon: "Camera",
    color: ID(1),
    label: "Capture",
    labelPlural: "Captures",
  },
  idea: {
    kind: "idea",
    category: "entity",
    icon: "Lightbulb",
    color: ID(4),
    label: "Idea",
    labelPlural: "Ideas",
  },

  // ── Non-entity object families ──
  entity: {
    kind: "entity",
    category: "entity",
    icon: "FileText",
    color: FALLBACK_COLOR,
    label: "Entity",
    labelPlural: "Entities",
  },
  view: {
    kind: "view",
    category: "view",
    icon: "LayoutGrid",
    color: ID(2),
    label: "View",
    labelPlural: "Views",
    glyph: "◰",
  },
  widget: {
    kind: "widget",
    category: "widget",
    icon: "LayoutGrid",
    color: ID(5),
    label: "Widget",
    labelPlural: "Widgets",
    glyph: "⊞",
  },
  /* The kind stays `cell` — that is the engine's word and the DB's. The LABEL is
     "Card" because that is the only word a user may see: NORTH-STAR.md §5 —
     "User-facing word is Card. 'Cell' is the internal engine term — never shown
     to users." This row said "Cell", so every surface resolving through the
     vocabulary printed "Install cell" / "Cell installed" at users. Fixing it
     here, at the one door, fixes all of them at once — which is exactly why a
     local label map at a call site is forbidden. */
  cell: {
    kind: "cell",
    category: "cell",
    icon: "SquareDashedBottomCode",
    color: ID(5),
    label: "Card",
    labelPlural: "Cards",
  },
  document: {
    kind: "document",
    category: "document",
    icon: "FileText",
    color: ID(4),
    label: "Document",
    labelPlural: "Documents",
    glyph: "▤",
  },
  channel: {
    kind: "channel",
    category: "channel",
    icon: "MessageSquare",
    color: ID(2),
    label: "Channel",
    labelPlural: "Channels",
    glyph: "#",
  },
  project: {
    kind: "project",
    category: "project",
    icon: "FolderKanban",
    color: ID(5),
    label: "Project",
    labelPlural: "Projects",
    glyph: "◈",
  },
  session: {
    kind: "session",
    category: "session",
    icon: "Rss",
    color: ID(11),
    label: "Session",
    labelPlural: "Sessions",
  },
  workspace: {
    kind: "workspace",
    category: "workspace",
    icon: "LayoutDashboard",
    color: ID(6),
    label: "Workspace",
    labelPlural: "Workspaces",
  },

  // ── System capabilities (the `/` universe) — spread across the wider palette ──
  skill: {
    kind: "skill",
    category: "skill",
    icon: "GraduationCap",
    color: ID(9),
    label: "Skill",
    labelPlural: "Skills",
  },
  automation: {
    kind: "automation",
    category: "automation",
    icon: "Zap",
    color: ID(7),
    label: "Automation",
    labelPlural: "Automations",
    glyph: "⚡",
  },
  playbook: {
    kind: "playbook",
    category: "playbook",
    icon: "BookOpen",
    color: ID(8),
    label: "Playbook",
    labelPlural: "Playbooks",
  },
  capability: {
    kind: "capability",
    category: "capability",
    icon: "Boxes",
    color: ID(10),
    label: "Capability",
    labelPlural: "Capabilities",
  },
  command: {
    kind: "command",
    category: "command",
    icon: "TerminalSquare",
    color: ID(1),
    label: "Command",
    labelPlural: "Commands",
  },
  tool: {
    kind: "tool",
    category: "tool",
    icon: "Wrench",
    color: ID(12),
    label: "Tool",
    labelPlural: "Tools",
  },

  // ── Graph-only kinds ──
  // `source`, `participant` and `run` are returned by `getObjectGraph`
  // (`GRAPH_KINDS`) and by the Processes queue, but had no identity entry, so
  // every surface that showed them either fell back to the neutral `Box` or
  // kept its own hand-written glyph/label map beside the registry. Registered
  // here so there is one answer.
  run: {
    kind: "run",
    category: "run",
    icon: "Play",
    color: ID(11),
    label: "Run",
    labelPlural: "Runs",
  },
  source: {
    kind: "source",
    category: "source",
    icon: "Database",
    color: ID(3),
    label: "Source",
    labelPlural: "Sources",
  },
  participant: {
    kind: "participant",
    category: "participant",
    icon: "User",
    color: ID(6),
    label: "Participant",
    labelPlural: "Participants",
  },

  // ── AI / governance (agent is ALWAYS emerald) ──
  agent: {
    kind: "agent",
    category: "agent",
    icon: "Bot",
    color: AI,
    label: "Agent",
    labelPlural: "Agents",
  },
  proposal: {
    kind: "proposal",
    category: "proposal",
    icon: "GitPullRequest",
    color: ID(4),
    label: "Proposal",
    labelPlural: "Proposals",
  },
  notification: {
    kind: "notification",
    category: "notification",
    icon: "Bell",
    color: ID(1),
    label: "Notification",
    labelPlural: "Notifications",
  },
};

// ─── View lenses ─────────────────────────────────────────────────────────────

/**
 * View-lens → Lucide icon NAME. The `view` kind is one identity, but a view
 * READS as its lens (a kanban vs a calendar vs a graph) — so a chip/menu row for
 * a view resolves its icon by lens via `subtype`. Seeded to MATCH the icons in
 * `VIEW_DEFINITIONS` (`@synap-core/capabilities`); a parity test in
 * `@synap-core/view-renderer` guards against drift (this leaf can't import
 * capabilities without a cycle, so the two are kept in lockstep by test).
 */
export const VIEW_LENS_ICONS: Record<string, string> = {
  sheet: "Sheet",
  table: "Table2",
  list: "List",
  grid: "LayoutGrid",
  gallery: "Images",
  kanban: "Columns",
  matrix: "Grid3x3",
  masonry: "LayoutGrid",
  calendar: "CalendarDays",
  gantt: "GanttChart",
  timeline: "GitCommitHorizontal",
  graph: "Network",
  flow: "Workflow",
  branch_tree: "GitBranch",
  bento: "LayoutDashboard",
  whiteboard: "PenTool",
  map: "MapPin",
  mindmap: "BrainCircuit",
};

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * The minimal profile shape identity resolution needs — a structural subset of a
 * backend profile row, so callers don't have to pull the full types package. Any
 * object carrying `uiHints` (icon/color) overlays the static default.
 */
export interface ProfileIdentityInput {
  /** The profile slug / entity type this profile represents. */
  slug?: string;
  label?: string;
  labelPlural?: string;
  /** Backend `profiles.uiHints` — the data-driven identity source. */
  uiHints?: { icon?: string | null; color?: string | null } | null;
  /** "kind" (a real object) vs "role" (a facet — client/partner/… — never its own object). */
  profileKind?: string | null;
}

/** Humanize an unknown kind key ("meeting_note" → "Meeting Note") for a fallback label. */
function humanize(kind: string): string {
  return kind
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve the identity for an object kind. THE one door — every surface calls
 * this instead of a local map.
 *
 * Order of precedence: the object's own `profile.uiHints` (data-driven, wins) →
 * the static `OBJECT_KINDS` default → a neutral humanized fallback for unknown
 * kinds. Passing `profile` is optional: a bare-`kind` surface and a full-profile
 * surface get the same answer, differing only in that the profile can override.
 */
export function resolveObjectIdentity(
  kind: string | null | undefined,
  profile?: ProfileIdentityInput | null,
  /** For `view` kind: the lens (kanban/calendar/graph/…) — overrides the icon. */
  subtype?: string | null
): ObjectKindDef {
  const key = (kind ?? profile?.slug ?? "").toString();
  const base: ObjectKindDef =
    OBJECT_KINDS[key] ??
    ({
      kind: key || "unknown",
      category: "entity",
      icon: FALLBACK_ICON,
      // Unknown/custom kind → a DISTINCT color from the hash pattern (not grey),
      // so every kind reads as its own thing. Untyped → neutral fallback.
      color: key ? identityToken(identitySlotForKind(key)) : FALLBACK_COLOR,
      label: profile?.label ?? (key ? humanize(key) : "Object"),
      labelPlural: profile?.labelPlural ?? (key ? humanize(key) : "Objects"),
    } satisfies ObjectKindDef);

  // A view reads as its lens — swap the icon for the lens icon when known.
  const lensIcon =
    base.category === "view" && subtype ? VIEW_LENS_ICONS[subtype] : undefined;
  const withLens = lensIcon ? { ...base, icon: lensIcon } : base;

  if (!profile) return withLens;

  const hintIcon = profile.uiHints?.icon?.trim();
  const hintColor = profile.uiHints?.color?.trim();
  return {
    ...withLens,
    icon: hintIcon || withLens.icon,
    // A profile may carry a token OR a hex; honor whatever the user/AI set.
    color: hintColor || withLens.color,
    label: profile.label ?? withLens.label,
    labelPlural: profile.labelPlural ?? withLens.labelPlural,
  };
}

/**
 * Turn an object's raw title into a compact, human display label for a chip —
 * collapses whitespace, unwraps a bare URL to `host/…tail`, and caps length with
 * an ellipsis. Used wherever an object is referenced by a label that might be a
 * giant URL or an overlong title (e.g. an entity whose title IS a LinkedIn URL).
 * This is DISPLAY cleaning; it is orthogonal to `sanitizeMarkerLabel` (which
 * makes a label safe to embed in the `[[…]]` grammar).
 */
export function toChipLabel(raw: string | null | undefined, max = 42): string {
  let s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "Untitled";
  // Bare URL → host + a short path tail (drop protocol, query, trailing slash).
  const urlMatch = s.match(/^https?:\/\/([^/\s]+)(\/[^?#\s]*)?/i);
  if (urlMatch) {
    const host = urlMatch[1].replace(/^www\./, "");
    const path = (urlMatch[2] ?? "").replace(/\/+$/, "");
    const tail = path ? (path.split("/").filter(Boolean).pop() ?? "") : "";
    s = tail ? `${host}/${tail}` : host;
  }
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s;
}

// ─── targetType → object-kind normalization ──────────────────────────────────

/**
 * Irregular targetType/subjectType → object-kind aliases. The backend
 * apply-registry (`approve-executors.ts`) and governance layer speak
 * `subjectType` strings (`focus_session`, `entity_facet`, `relation`, …) that
 * don't match the `OBJECT_KINDS` vocabulary 1:1. This map is the SSOT for the
 * irregulars; regular plural→singular is handled mechanically below.
 */
export const OBJECT_KIND_ALIASES: Record<string, string> = {
  focus_session: "session",
  focus_sessions: "session",
  entity_facet: "facet",
  entity_facets: "facet",
  relation: "link",
  relations: "link",
  property_def: "property",
  property_defs: "property",
  /**
   * The Control Plane's PUBLISH vocabulary calls this kind `workflow`; the pod's
   * install/runtime vocabulary calls the same thing `automation`. Without this
   * row `resolveObjectNoun("workflow")` fell through to `humanizeToken` and the
   * icon lookup missed entirely — so one package rendered as "Automation" on the
   * landing site and "Workflow" with a fallback Box icon in the browser and
   * pod-admin. Same object, three presentations, which is precisely what this
   * table exists to prevent.
   */
  workflow: "automation",
  workflows: "automation",
};

/**
 * Normalize a backend `targetType`/`subjectType`/`proposalType` subject string to
 * the object-kind key the manifest is keyed by. Mechanical + irregular-aware:
 *   `focus_session` → `session`, `entity_facet` → `facet`, `relation` → `link`,
 *   `workspaces` → `workspace`, `views` → `view`, `companies` → `company`.
 * Unknown/empty → `entity` (the safe default kind). Pure + zero-dep — the render
 * layer and any backend-mirroring caller share ONE normalization.
 */
export function normalizeObjectKind(
  targetType: string | null | undefined
): string {
  const raw = (targetType ?? "").toString().trim().toLowerCase();
  if (!raw) return "entity";
  if (OBJECT_KIND_ALIASES[raw]) return OBJECT_KIND_ALIASES[raw];
  // Regular depluralization → singular.
  let singular = raw;
  if (raw.endsWith("ies"))
    singular = `${raw.slice(0, -3)}y`; // companies → company
  else if (raw.endsWith("ses"))
    singular = raw.slice(0, -2); // processes → process
  else if (raw.endsWith("s") && !raw.endsWith("ss"))
    singular = raw.slice(0, -1); // workspaces → workspace
  // Re-check the alias map after depluralizing (e.g. `relations` → `relation` → `link`).
  return OBJECT_KIND_ALIASES[singular] ?? singular;
}

/** Convenience accessors (each just reads one field off `resolveObjectIdentity`). */
export const resolveObjectIcon = (
  kind?: string | null,
  profile?: ProfileIdentityInput | null,
  subtype?: string | null
): string => resolveObjectIdentity(kind, profile, subtype).icon;
export const resolveObjectColor = (
  kind?: string | null,
  profile?: ProfileIdentityInput | null
): string => resolveObjectIdentity(kind, profile).color;
export const resolveObjectLabel = (
  kind?: string | null,
  profile?: ProfileIdentityInput | null
): string => resolveObjectIdentity(kind, profile).label;
