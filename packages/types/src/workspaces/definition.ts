/**
 * The workspace definition a template / package / preset hands the pod's
 * `createFromDefinition` and `reconcileFromDefinition` doors.
 *
 * Declared HERE, once: `@synap/database`
 * (`utils/create-workspace-from-definition.ts`) imports and re-exports it. The
 * doors' zod schemas stay with the doors; `WorkspaceIntentDefinition` mirrors
 * the zod-inferred type there and the database proves the two equal
 * (`packages/database/src/wire-parity/workspaces.ts`). Pure types: nothing from
 * the database package.
 */

import type {
  WorkspaceDefaultSource,
  WorkspaceLayoutDefinition,
  WorkspaceSettings,
  WorkspaceSourceRole,
  WorkspaceVisibility,
} from "./settings.js";

/** The authoring shape of a lifecycle on a template profile. */
export interface LifecycleAuthoring {
  /** The lifecycle property's slug (must be one of the profile's properties). */
  property: string;
  /** `[{ key, label?, category, tone?, humanOnly? }]` — every option needs a category. */
  options: unknown[];
}

/**
 * A template's `meta.intent` as a compiled definition carries it (top-level
 * `intent`). Mirrors `workspaceIntentDefinitionSchema` in
 * `@synap/database` `utils/workspace-intent.ts`.
 */
export interface WorkspaceIntentDefinition {
  label: string;
  produces?: { profile: string }[];
}

/**
 * Subset of PackageDefinition fields consumed by this utility.
 *
 * Supports two input formats interchangeably:
 *
 * 1. **Frontend proposal format** (used by local templates / useCreateWorkspaceFromProposal)
 *    - `profiles[].icon`, `profiles[].color`, `profiles[].description` — direct fields
 *    - `profiles[].properties[]` — flat array with `label`, `inputType`, `enumValues`
 *
 * 2. **Control-plane registry format** (used by CP templates / createFromDefinition fast path)
 *    - `profiles[].uiHints.icon`, `profiles[].uiHints.color`, `profiles[].uiHints.description`
 *    - `profiles[].propertyDefs[]` — with nested `uiHints.label/inputType` and `constraints.enum`
 *
 * The `createWorkspaceFromDefinition` function normalizes both formats transparently
 * before processing (see the profile loop in the implementation).
 */
/**
 * A flow automation as the reconcile door consumes it. Structurally mirrors
 * `PackageAutomationWire` (@synap-core/workspace-templates `define.ts`) — the
 * exact shape `toWorkspaceDefinition` already emits onto `flowAutomations` —
 * declared LOCALLY because `@synap/database` must not depend on the synap-app
 * template package (layering). Keep in sync with `PackageAutomationWire`:
 * `flowDefinition` is the loose `{ nodes; edges; precondition? }` the wire
 * carries (cast to `FlowDefinition` at the DB boundary in the door).
 */
export interface WorkspaceAutomationInput {
  /** Stable template identity; names may be edited without orphaning the flow. */
  key?: string;
  name: string;
  description?: string;
  triggerType: "event" | "cron" | "webhook" | "manual";
  triggerConfig?: Record<string, unknown>;
  flowDefinition?: {
    nodes: unknown[];
    edges: unknown[];
    precondition?: string;
  };
  status?: "draft" | "active" | "paused";
}

/**
 * A default intelligence command as the reconcile door consumes it. Mirrors
 * `DefaultCommandDef` (ensure-default-commands.ts) — create-if-`title`-missing,
 * no version. `outputMode`/`permissionsProfile`/`derivedInputs[].type` are
 * typed loosely here (string) to match the template wire and are narrowed to
 * their DB enums at the insert boundary in the door.
 */
export interface WorkspaceCommandInput {
  title: string;
  promptTemplate: string;
  derivedInputs?: Array<{ name: string; label: string; type: string }>;
  outputMode?: string;
  canCreateViews?: boolean;
  permissionsProfile?: string;
}

export interface WorkspaceDefinitionInput {
  workspaceName?: string;
  description?: string;
  /** Free-form subtype, e.g. "brand-library", "research-library". No fixed enum. */
  workspaceSubtype?: string;
  /** Per-workspace onboarding context — written to settings.onboarding. */
  onboarding?: WorkspaceSettings["onboarding"];
  /** Discovery/read visibility. Write access remains role-based. */
  workspaceVisibility?: WorkspaceVisibility;
  /** Capability ids this workspace provides or consumes. */
  workspaceCapabilities?: string[];
  /**
   * WHAT THIS WORKSPACE NEEDS TO FUNCTION — the abstract intents (closed
   * vocabulary, the pod's `capability_intents` table) its template declares it
   * requires. Distinct from `workspaceCapabilities`, which names what this space
   * PROVIDES to others; this is what it CONSUMES.
   *
   * Persisted verbatim to `settings.taskIntents` (JSONB — no column, no
   * migration). It is a DECLARATION, not a snapshot: a gap between this list and
   * what is installed is the field doing its job, and is what the intent
   * resolver reports and can propose an install for. Never a reconciliation
   * target.
   *
   * Validation lives at the AUTHORING layer (`validateTemplate`'s
   * `task-intent-unknown` in `@synap-core/types`' workspace-templates), where
   * the closed vocabulary is importable. This is the transport, so it stays a
   * plain string array — a slug the pod's router does not know is reported by
   * the resolver as unsatisfied, never silently dropped.
   */
  taskIntents?: string[];
  /**
   * What this space PRODUCES — the template's `meta.intent`, compiled onto the
   * definition's top level. Projected to `settings.intent` by
   * `projectTemplateIntent` here and in the reconcile.
   */
  intent?: WorkspaceIntentDefinition;
  /** Product-surface policy for the existing CRM workspace. */
  crm?: WorkspaceSettings["crm"];
  /** Domain → provider/consumer role map. */
  sourceRoles?: Record<string, WorkspaceSourceRole>;
  /** Domain/capability → default source workspace references. */
  defaultSources?: Record<string, WorkspaceDefaultSource>;
  /**
   * Workspace composition (north star §10): import/extend bricks (profiles +
   * views) from another SHARED/PUBLIC/SYSTEM workspace. Each `source` is a
   * workspaceId or a systemSlug; omit `import` (or a key within it) to import
   * all profiles/views. Resolved + merged by `resolveWorkspaceExtends()` in the
   * API layer BEFORE this definition is materialized — by the time
   * `createWorkspaceFromDefinition` runs, `extends` has been flattened into
   * `profiles`/`views` (COPY semantics) and removed.
   */
  extends?: Array<{
    source: string;
    import?: {
      profiles?: string[];
      views?: string[];
    };
  }>;
  profiles?: Array<{
    slug: string;
    displayName: string;
    // Proposal format: direct fields
    icon?: string;
    color?: string;
    description?: string;
    scope?: string;
    /**
     * Whether entities of this profile type are pod-wide (visible in ALL
     * workspaces) or workspace-scoped. Threaded verbatim into
     * `ProfileRepository.create` — omit to inherit the repo default
     * (`"workspace"`), which is the unchanged behavior for templates that do not
     * declare it. Product-neutral: any template may set this (it is no longer
     * reachable only through the hardcoded `POD_WIDE_SLUGS` seed set).
     */
    entityScope?: "pod" | "workspace";
    /**
     * Semantic identity tag for cross-workspace queries. Defaults to the profile's slug.
     * Set to null to mark this profile as private (no cross-workspace semantics).
     */
    semanticSlug?: string | null;
    /** Kind vs role profile. Omit for default ('kind'). */
    profileKind?: "kind" | "role";
    /** For profileKind='role': which base-kind profile slugs this role can attach to. */
    applicableKinds?: string[];
    /**
     * Role-category grouping key (migration 0222). Threaded into
     * `ProfileRepository.create` — a role tagged e.g. `roleCategory: "provider"`
     * joins that cohort so `entity.query { roleCategory }` matches it. Omit/null
     * = no category.
     */
    roleCategory?: string | null;
    /**
     * The profile's ONE lifecycle (work model L1, 0319): which property it is
     * and its options, each with a fixed category. Folded onto that property
     * (`withLifecycleOptions`) and declared (`declareLifecycle`) on apply.
     */
    lifecycle?: LifecycleAuthoring;
    /**
     * How the kind PRESENTS itself (`ProfilePresentation`,
     * `@synap-core/types/presentation`): family + media source + per-altitude
     * fields. Stored as `uiHints.presentation` and converged on every apply
     * through `setProfilePresentation` (create AND reconcile, new AND reused
     * profiles). Parsed by the doors that accept it, not here.
     */
    presentation?: Record<string, unknown>;
    // Proposal format: flat property list
    properties?: Array<{
      slug: string;
      label?: string;
      valueType: string;
      inputType?: string;
      placeholder?: string;
      enumValues?: string[];
      /** Option objects `{ key, label?, category?, tone?, humanOnly? }` (wins over enumValues). */
      enumOptions?: unknown[];
      constraints?: Record<string, unknown>;
      /** entity_id properties: which profile slug this field links to */
      targetProfileSlug?: string;
    }>;
    // CP registry format (alternative to the above direct fields)
    uiHints?: {
      icon?: string;
      color?: string;
      description?: string;
      hideFromCreate?: boolean;
      /** CP registry spelling of `presentation` (the top-level one wins). */
      presentation?: Record<string, unknown>;
    };
    // CP registry format (alternative to `properties`)
    propertyDefs?: Array<{
      slug: string;
      valueType: string;
      required?: boolean;
      constraints?: { enum?: string[]; [k: string]: unknown };
      uiHints?: {
        label?: string;
        inputType?: string;
        placeholder?: string;
      };
    }>;
  }>;
  views?: Array<{
    /** View name in proposal format. Accepts both 'name' and 'displayName' (registry format). */
    name?: string;
    displayName?: string;
    /** Optional stable slug for the view (used for reference; not stored as a DB column). */
    slug?: string;
    type: string;
    scopeProfileSlug?: string;
    scopeProfileSlugs?: string[];
    config?: Record<string, unknown>;
    // View configuration — merged into config when saving to DB
    groupBy?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    filterBy?: Record<string, unknown>;
    description?: string;
    defaultView?: boolean;
    hierarchyEdges?: Array<{ parent: string; child: string; via?: string }>;
    startField?: string;
    endField?: string;
    colorBy?: string;
  }>;
  bentoLayout?: Array<{
    widgetType: string;
    pos: { x: number; y: number; w: number; h: number };
    config?: Record<string, unknown>;
  }>;
  bentoViewBlocks?: Array<{
    kind: "view";
    viewName: string;
    viewSlug?: string;
    pos: { x: number; y: number; w: number; h: number };
    overrides?: Record<string, unknown>;
  }>;
  /** Override the default "Home" name for the workspace home bento view */
  bentoViewName?: string;
  suggestedEntities?: Array<{
    profileSlug: string;
    title: string;
    properties?: Record<string, unknown>;
    content?: string;
  }>;
  /** Alias for suggestedEntities — some templates use this name. Normalized before processing. */
  seedEntities?: Array<{
    profileSlug: string;
    title: string;
    properties?: Record<string, unknown>;
    content?: string;
  }>;
  suggestedRelations?: Array<{
    sourceRef: string;
    targetRef: string;
    type: string;
    metadata?: Record<string, unknown>;
  }>;
  displayTemplates?: Array<{
    name: string;
    description?: string;
    entityType?: string;
    targetType?: string;
    isDefault?: boolean;
    config: Record<string, unknown>;
  }>;
  layoutConfig?: WorkspaceLayoutDefinition & {
    pinnedApps?: string[];
    defaultView?: string;
    sidebarItems?: Array<{
      kind: "app" | "view" | "profile" | "external" | "cell";
      appId?: string;
      viewName?: string;
      viewId?: string;
      profileSlug?: string;
      url?: string;
      cellKey?: string;
      cellProps?: Record<string, unknown>;
      surface?: {
        kind:
          "cell" | "view" | "entity" | "document" | "channel" | "app" | "url";
        cellKey?: string;
        viewId?: string;
        viewName?: string;
        entityId?: string;
        documentId?: string;
        channelId?: string;
        appId?: string;
        url?: string;
        srcdoc?: string;
        rendererType?: "native" | "external" | "iframe-srcdoc";
        external?: boolean;
        placement?:
          "main" | "side" | "floating" | "modal" | "popover" | "embed";
        displayMode?: "compact" | "medium" | "full";
        props?: Record<string, unknown>;
        title?: string;
        workspaceId?: string | null;
        meta?: Record<string, unknown>;
      };
      label?: string;
      icon?: string;
      section?: string;
      matchUrls?: string[];
    }>;
  };
  /**
   * Per-profile default bento layout used when opening a single entity of that type.
   * Stored in workspace.settings.profileEntityBentoTemplates.
   * Example: { "deal": { blocks: [...] } }
   */
  profileEntityBentoTemplates?: Record<
    string,
    { blocks: Array<Record<string, unknown>> }
  >;

  /** Schema-level links between entity types (profiles). Creates relation_defs + profile_relations. */
  entityLinks?: Array<{
    sourceProfileSlug: string;
    targetProfileSlug: string;
    type: string;
    label?: string;
    /**
     * Every record of the source kind should carry this link (to one of the
     * target kinds declaring the same `type`). Stored on
     * `profile_relations.metadata.required`; reconcile writes it on an
     * installed link too. Today the pod WARNS on a create that lacks it and
     * lists the rows missing it in template health; it never refuses yet.
     * `false` clears a stored mark; absent leaves the stored mark as it is.
     */
    required?: boolean;
  }>;

  /**
   * Flow automations reconciled version-aware by the door, keyed on
   * `(workspaceId, name)`. Populated by `toWorkspaceDefinition` from a
   * template's `automations[]`. Reconciled by `reconcileWorkspaceFromDefinition`
   * only (the create door does NOT materialize these — automations arrive via
   * the reconcile pass on `workspaces.get` / boot sweep).
   */
  flowAutomations?: WorkspaceAutomationInput[];

  /**
   * Default intelligence commands seeded create-if-`title`-missing by the door.
   * No version — a command is owned by the user after first seed. Reconciled by
   * `reconcileWorkspaceFromDefinition` only.
   */
  commands?: WorkspaceCommandInput[];

  /**
   * Full relation-def metadata seeded create-if-`slug`-missing by the door.
   * DISTINCT from `entityLinks`: that step reuses the def a slug already
   * resolves to and creates one only for a slug nothing resolves (taking this
   * list's metadata when declared) — `resolveOrCreateForLink`. A template
   * shipping the full `DefaultRelationDef` set (see `default-relation-defs.ts`)
   * carries it here.
   * No version — user-owned after first seed. Reconciled by
   * `reconcileWorkspaceFromDefinition` only.
   */
  relationDefs?: Array<{
    slug: string;
    displayName: string;
    description?: string;
    isDirectional?: boolean;
    uiHints?: { category?: string; inverseLabel?: string };
  }>;
}
