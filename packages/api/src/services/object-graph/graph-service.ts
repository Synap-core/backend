/**
 * Object-Graph Service — "graph by default" for ANY object kind.
 *
 * The read-side dual of Synap's homoiconic substrate: if everything is ONE
 * typed-JSON graph (entities + config/runtime nodes joined by `relations` and
 * `links`), then every READ should return the object PLUS its local neighbourhood
 * — what it is connected to, typed. One uniform envelope for entity / view /
 * channel / session / playbook / tool / skill / automation / project / document,
 * so a new object kind is a graph citizen for free (no new endpoint).
 *
 * This service owns the CONFIG/RUNTIME half (the `links` graph) + the per-kind
 * NAME/SUBTYPE hydrator — the piece that was missing (`getLinksFor` returned raw
 * edges, `getConnections` hydrated only entities). The ENTITY-DATA half
 * (relations + property + channel) stays in `relations.getConnections` and is
 * merged in at the route layer (which holds the tRPC ctx). Dependency-light like
 * `links-service`: userId-scoped, no governance/event side effects.
 *
 * See team/platform/playbooks-capability-substrate.mdx (the `links` mirror of
 * `relations`) + the homoiconic substrate white-paper.
 */

import {
  getDb,
  inArray,
  and,
  or,
  eq,
  isNull,
  ilike,
  entities,
  projects,
  views,
  channels,
  channelMembers,
  ChannelMemberKind,
  focusSessions,
  playbooks,
  tools,
  skills,
  capabilities,
  automations,
  documents,
  intelligenceCommands,
  agents,
  vaultGrants,
  events,
  proposals,
  desc,
  isNotNull,
  GRANTABLE_TYPES,
  type GrantableType,
  loadFacetSlugsBatch,
  type FacetVisibilityScope,
  workspaces,
  ProfileRepository,
} from "@synap/database";
import { ownAdjunctFilter, authoredByUser } from "../agent-identity-service.js";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { LinkEndpointType } from "@synap/playbooks";
import { getLinksFor } from "../links/links-service.js";
import {
  userVisibleWhere,
  workspaceLensWhere,
  ownerPrivateVisibleWhere,
} from "../../utils/user-visible-where.js";
import { accessScopeWhere } from "../../utils/project-scope.js";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";
import type { EntityConnection } from "./entity-connections.js";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";

/**
 * Kinds the graph envelope can focus on. Superset of `LinkEndpointType` so
 * entity-data kinds (view, document) are addressable too — they hydrate via the
 * KIND_TABLE registry. ONE source of truth, shared by the REST route, the tRPC
 * procedure, and the MCP tool so the addressable surface can't drift.
 */
export const GRAPH_KINDS = [
  "entity",
  "project",
  "view",
  "channel",
  "session",
  "playbook",
  "tool",
  "skill",
  "capability",
  "agent",
  "automation",
  "document",
  "command",
  "source",
  "participant",
  "workspace",
] as const;

export type GraphKind = (typeof GRAPH_KINDS)[number];

/**
 * Entity-backed kinds carry the relations/property/channel DATA graph on top of
 * their links graph — the caller folds in `getConnections` for these (it needs
 * the tRPC ctx, so it can't be fetched inside the dependency-light service).
 */
export const ENTITY_BACKED: ReadonlySet<string> = new Set([
  "entity",
  "project",
]);

/** A node in the pod graph — uniform across every object kind. */
export interface GraphNode {
  /** The object's table/kind (the link-endpoint type). */
  kind: string;
  /** The object's id (uuid or kind short-id). */
  id: string;
  /** Human-facing name — the handle you navigate by (id stays canonical). */
  name: string;
  /** In-kind discriminator: entity→profileSlug, view→viewType, tool/skill→kind… */
  subtype: string | null;
  /**
   * Same discriminator, pluralized: entity→[kind slug, ...facet slugs] (Kind+
   * Facets — an entity can carry multiple role-profiles), other kinds→[subtype]
   * or []. `subtype` is kept for compat; new consumers should prefer this.
   */
  subtypes: string[];
  workspaceId: string | null;
}

/** A neighbour = a node + the edge that connects it to the focused object. */
export interface GraphNeighbor extends GraphNode {
  /** linkType (config edge) or relationType (data edge). */
  edgeType: string;
  direction: "outgoing" | "incoming" | "structural";
  /** Which substrate the edge came from — glass-box provenance. */
  via:
    | "links"
    | "relations"
    | "property"
    | "channel"
    | "session"
    // vault_grants (capability grants) — NOT mirrored into `links`, folded in
    // read-time for capability/tool/skill/command↔agent bindings.
    | "grant"
    // automations.createdBy ownership — an agent → the automations it authored.
    | "automation"
    // ── The TEMPORAL half (why-spine) ────────────────────────────────────────
    // Neither of these is a stored EDGE: both are derived at read time from the
    // append-only `events` spine, which is the only substrate that knows WHEN.
    // The file's own header used to admit this gap ("the runs/governs dimension
    // has no stored link").
    //
    // `governed`   — the PROPOSAL that authorized a change to this object,
    //                reached via `events.proposal_id` on an event whose subject
    //                IS this object.
    // `produced-in`— the SESSION the change happened in, reached via
    //                `events.session_id` (0241) or the proposal's own
    //                `session_id`. A session is the only handle on the spine
    //                carrying an INTENT (`focus_sessions.goal` is NOT NULL), so
    //                this is the edge that answers "why does this look like this".
    | "governed"
    | "produced-in"
    // `entities.documentId` — an entity's body document. A plain FK column,
    // never mirrored into `links` or `relations`, so a `document` focus had no
    // way to see the entity(ies) that use it as their body (get_graph on a
    // document returned empty neighbours even when entities pointed at it).
    // Folded in read-time by `getDocumentBodyNeighbors`, direction "incoming"
    // (the document is the target of the FK).
    | "body";
}

/** "Fetch X, get X + everything it's linked to, typed." */
export interface GraphEnvelope {
  object: GraphNode;
  neighbors: GraphNeighbor[];
  counts: {
    total: number;
    byKind: Record<string, number>;
    byVia: Record<string, number>;
  };
  /**
   * Whether the focal object was actually resolved. `false` = the id hydrated to
   * NOTHING and has no visible neighbours (a genuinely-unknown / invisible id) —
   * `object` is then a not-found placeholder, NOT a real node. `true` = either
   * hydrated, or a stub node corroborated by ≥1 visible edge. Callers surface a
   * "not found" instead of rendering the placeholder as a real entity.
   */
  found: boolean;
}

// ── Per-kind hydrator registry ───────────────────────────────────────────────
// The extensible heart: (kind, ids[]) → batch fetch name+subtype. One entry per
// table-backed kind; a new kind = one row here, and it's a graph citizen
// everywhere. The fall-through (raw-id node) is reserved for endpoint kinds that
// are NOT a single table: `participant` (a user/agent identity — its fromId is a
// userId/agentUserId, pod-global, scoped differently) and `source` (reserved in
// LinkEndpointType, no table/writer yet). Those still SHOW the edge, never drop
// it. Everything table-backed — including `command` (intelligence_commands) — is
// fully hydrated below.

interface KindSpec {
  table: any;
  name: string; // column name for the display name
  subtype?: string; // column name for the in-kind discriminator
  deletedAt?: string;
}

/**
 * `project` is a `projects` table row — a first-class table, NOT an entity.
 */
const KIND_TABLE: Record<string, KindSpec> = {
  entity: {
    table: entities,
    name: "title",
    subtype: "type",
    deletedAt: "deletedAt",
  },
  project: { table: projects, name: "name", subtype: "status" },
  view: { table: views, name: "name", subtype: "type" },
  channel: { table: channels, name: "title", subtype: "channelType" },
  session: { table: focusSessions, name: "goal" },
  playbook: { table: playbooks, name: "name" },
  tool: { table: tools, name: "name", subtype: "kind" },
  skill: { table: skills, name: "name", subtype: "kind" },
  capability: { table: capabilities, name: "name" },
  // The `agents` REGISTRY row (id = agents.id). Pod-global reference data — no
  // `workspaceId` column, so hydrateNodes scopes it via the agent floor below
  // (system-owned OR owned by the caller), NOT workspaceLensWhere.
  agent: { table: agents, name: "name" },
  command: { table: intelligenceCommands, name: "title" },
  automation: { table: automations, name: "name", subtype: "triggerType" },
  document: {
    table: documents,
    name: "title",
    subtype: "type",
    deletedAt: "deletedAt",
  },
  workspace: { table: workspaces, name: "name" },
};

/**
 * The per-kind READ FLOOR for node hydration — the ONE place that decides which
 * rows of a `KIND_TABLE` table this caller may see the NAME of.
 *
 * Extracted from `hydrateNodes` because the default is UNSAFE for a whole class
 * of tables and the exceptions must be readable rather than buried in a nested
 * ternary. The trap it exists to close:
 *
 *   `workspaceLensWhere` floors on `userVisibleWhere`, whose `isNull(workspaceId)`
 *   branch is OWNER-BLIND (no `user_id` term). On an `ownerPrivate` table — one
 *   where a NULL workspace means "personal to the owner" — that admits EVERY
 *   user's private rows to EVERY pod user. `user-visible-where.ts` warns about
 *   exactly this, and names focus_sessions / entities / documents.
 *
 * So the rule is: **check `nullWorkspaceMeans` in `access/registry.ts` before
 * adding a kind here.** `podGlobalConfig` may use the plain lens; `ownerPrivate`
 * MUST NOT. Note that some ownerPrivate tables (`projects`, `views`,
 * `focus_sessions`) have NO registered rule at all — unclassified is not the same
 * as safe; their own routers hand-inline the owner-gate, which is the tell.
 * Enforced by `__tripwires__/hydration-floor-owner-private.test.ts`.
 *
 * Every branch must ALSO honour the workspace lens. The owner-aware helpers
 * (`ownerPrivateVisibleWhere`, `channelVisibilityWhere`) carry no workspace
 * dimension, so the lens is re-ANDed via `lensNarrowing` — an AND can only
 * narrow, so it cannot reopen the owner hole.
 */

/**
 * The workspace-lens narrowing as a standalone conjunct, matching
 * `workspaceLensWhere`'s three lens states: `undefined` → no narrowing,
 * `null` → globals only, `"<id>"` → that workspace only. Returned as
 * `undefined` for the no-narrowing case so Drizzle's `and()` drops it.
 */
function lensNarrowing(column: AnyPgColumn, lens: string | null | undefined) {
  if (lens === undefined) return undefined;
  if (lens === null) return isNull(column);
  return eq(column, lens);
}

function hydrationScopeWhere(
  kind: string,
  t: any,
  userId: string,
  workspaceId?: string | null
) {
  switch (kind) {
    // `workspace` has no `workspaceId` column — the row IS the workspace, so its
    // own `id` is the scope dimension (userVisibleWhere accepts any column).
    case "workspace":
      return and(
        isNull((t as typeof workspaces).archivedAt),
        workspaceLensWhere(t.id, userId, workspaceId)
      );
    // Agents have no `workspaceId` — a pod-global registry. SYSTEM-owned (shared
    // built-ins) OR owned by this caller (private local adjuncts stay owner-only).
    case "agent":
      return or(
        eq((t as typeof agents).ownerType, "system"),
        ownAdjunctFilter(userId)
      );
    // ownerPrivate + part of the entity-facet substrate → the canonical entity
    // READ scope (owner-gated NULL + membership + exposure + role-lens).
    case "entity":
      return accessScopeWhere({
        workspaceIdColumn: entities.workspaceId,
        entityIdColumn: entities.id,
        ownerColumn: entities.userId,
        userId,
        workspaceLens: workspaceId,
        facetLens: true,
      });
    // ownerPrivate, NOT facet-substrate → the minimal owner-gate.
    // `documents` is the sharp one: its create door DELIBERATELY lands pod-wide
    // when no workspace signal is present (routers/documents.ts:124-127), so a
    // NULL workspace is the DEFAULT here, not a rare edge case.
    case "document":
      return and(
        ownerPrivateVisibleWhere(
          (t as typeof documents).workspaceId,
          (t as typeof documents).userId,
          userId
        ),
        lensNarrowing((t as typeof documents).workspaceId, workspaceId)
      );
    case "session":
      return and(
        ownerPrivateVisibleWhere(
          (t as typeof focusSessions).workspaceId,
          (t as typeof focusSessions).userId,
          userId
        ),
        lensNarrowing((t as typeof focusSessions).workspaceId, workspaceId)
      );
    // `projects` and `views` are ownerPrivate BY BEHAVIOUR but have no registered
    // VisibilityRule — their own routers hand-inline the owner-gate
    // (routers/projects.ts:87, routers/views.ts:72), which is what proves the
    // semantics. Both have a nullable `workspace_id` and a NOT NULL `user_id`, so
    // the plain lens would expose every user's personal projects/views by name.
    case "project":
      return and(
        ownerPrivateVisibleWhere(
          (t as typeof projects).workspaceId,
          (t as typeof projects).userId,
          userId
        ),
        lensNarrowing((t as typeof projects).workspaceId, workspaceId)
      );
    case "view":
      return and(
        ownerPrivateVisibleWhere(
          (t as typeof views).workspaceId,
          (t as typeof views).userId,
          userId
        ),
        lensNarrowing((t as typeof views).workspaceId, workspaceId)
      );
    // Channels are ownerPrivate but NOT uniformly owner-gated: a NULL-workspace
    // PERSONAL channel is owner-private, while a shared-TYPE NULL channel is
    // legitimately pod-wide. `ownerPrivateVisibleWhere` would over-restrict and
    // hide shared channels. Use the canonical predicate the channels router and
    // the registry's own VisibilityRule both use.
    case "channel":
      return and(
        channelVisibilityWhere(userId),
        lensNarrowing((t as typeof channels).workspaceId, workspaceId)
      );
    default:
      return workspaceLensWhere(t.workspaceId, userId, workspaceId);
  }
}

/**
 * Batch-hydrate a set of (kind, id) refs into named nodes — ONE query per kind,
 * never N+1. Unknown/stub kinds resolve to a raw-id node (name = short id) so
 * the neighbour is still listed.
 */
export async function hydrateNodes(
  userId: string,
  refs: { kind: string; id: string }[],
  facetVisibilityScope: FacetVisibilityScope,
  workspaceId?: string | null
): Promise<Map<string, GraphNode>> {
  const out = new Map<string, GraphNode>();
  if (refs.length === 0) return out;

  // Group ids by kind for one batched query per table.
  const idsByKind = new Map<string, Set<string>>();
  for (const r of refs) {
    let set = idsByKind.get(r.kind);
    if (!set) idsByKind.set(r.kind, (set = new Set()));
    set.add(r.id);
  }

  const db = await getDb();
  await Promise.all(
    [...idsByKind].map(async ([kind, idSet]) => {
      const ids = [...idSet];
      const spec = KIND_TABLE[kind];
      if (!spec) {
        // Stub kind — no table. Show the edge with a raw-id handle.
        for (const id of ids) {
          out.set(`${kind}:${id}`, {
            kind,
            id,
            name: id.length > 12 ? `${id.slice(0, 8)}…` : id,
            subtype: null,
            subtypes: [],
            workspaceId: null,
          });
        }
        return;
      }
      const t = spec.table;
      // SCOPE the hydration — an edge can be visible while its far endpoint lives
      // in a workspace the user can't see; without this AND, the neighbour's NAME
      // would leak. Per-kind floors live in `hydrationScopeWhere` above; read its
      // header before adding a kind (the default is unsafe for ownerPrivate).
      const rows = await db
        .select()
        .from(t)
        .where(
          and(
            inArray(t.id, ids),
            spec.deletedAt ? isNull(t[spec.deletedAt]) : undefined,
            hydrationScopeWhere(kind, t, userId, workspaceId)
          )
        );

      // Entity kind carries facets on top of its base subtype (kind slug) —
      // batch-load live facet slugs for every entity in this group.
      const facetSlugsByEntity =
        kind === "entity"
          ? await loadFacetSlugs(db, ids, facetVisibilityScope)
          : null;

      for (const row of rows as Record<string, unknown>[]) {
        const id = row.id as string;
        const subtype = spec.subtype
          ? ((row[spec.subtype] as string | null) ?? null)
          : null;
        const subtypes = subtype ? [subtype] : [];
        if (facetSlugsByEntity)
          subtypes.push(...(facetSlugsByEntity.get(id) ?? []));
        out.set(`${kind}:${id}`, {
          kind,
          id,
          name: (row[spec.name] as string | null) ?? "(untitled)",
          subtype,
          subtypes,
          workspaceId: (row.workspaceId as string | null) ?? null,
        });
      }
    })
  );
  return out;
}

/**
 * Batch-load live facet (role-profile) slugs for a set of entity ids —
 * delegates to the canonical loadFacetSlugsBatch join in @synap/database.
 */
async function loadFacetSlugs(
  db: Awaited<ReturnType<typeof getDb>>,
  entityIds: string[],
  facetVisibilityScope: FacetVisibilityScope
): Promise<Map<string, string[]>> {
  return loadFacetSlugsBatch(db, entityIds, facetVisibilityScope);
}

/**
 * The CONFIG/RUNTIME neighbours of any object — `getLinksFor` edges hydrated to
 * typed nodes. The other endpoint of each edge (the side that isn't the focused
 * object) becomes a neighbour, tagged with its linkType + direction.
 */
export async function getLinkNeighbors(
  userId: string,
  kind: LinkEndpointType,
  id: string,
  facetVisibilityScope: FacetVisibilityScope,
  workspaceId?: string | null
): Promise<GraphNeighbor[]> {
  const edges = await getLinksFor(userId, kind, id, workspaceId);
  if (edges.length === 0) return [];

  // The "other" endpoint of each edge + the direction relative to the focus.
  const refs = edges.map((e) => {
    const outgoing = e.fromType === kind && e.fromId === id;
    return {
      kind: outgoing ? e.toType : e.fromType,
      id: outgoing ? e.toId : e.fromId,
      edgeType: e.linkType,
      direction: outgoing ? ("outgoing" as const) : ("incoming" as const),
    };
  });

  const nodes = await hydrateNodes(
    userId,
    refs.map((r) => ({ kind: r.kind, id: r.id })),
    facetVisibilityScope,
    workspaceId
  );
  return refs.map((r) => {
    const node = nodes.get(`${r.kind}:${r.id}`);
    return {
      kind: r.kind,
      id: r.id,
      name: node?.name ?? r.id,
      subtype: node?.subtype ?? null,
      subtypes: node?.subtypes ?? [],
      workspaceId: node?.workspaceId ?? null,
      edgeType: r.edgeType,
      direction: r.direction,
      via: "links" as const,
    };
  });
}

/**
 * Map the ENTITY-DATA graph (`relations.getConnections` Connection rows) into the
 * uniform neighbour shape, so the route layer can fold it into the envelope. Pure
 * — the caller already fetched the connections (it holds the tRPC ctx). The
 * `source` discriminator becomes our `via`:
 *   graph            → relations
 *   property         → property
 *   thread           → channel  (channel_context_items: messages that touched entity)
 *   context_channel  → channel  (channels.contextObjectId: channel opened ON entity)
 *   focus_session    → session  (focus_sessions.subjectEntityId: session about entity)
 */
export function connectionsToNeighbors(
  connections: EntityConnection[]
): GraphNeighbor[] {
  return connections.map((c) => {
    const isEntity = c.source === "graph" || c.source === "property";
    const isSession = c.source === "focus_session";
    const id = isSession
      ? (c.focusSessionId ?? c.entityId)
      : isEntity
        ? c.entityId
        : (c.channelId ?? c.entityId);

    return {
      kind: isEntity ? "entity" : isSession ? "session" : "channel",
      id,
      name: isEntity
        ? (c.entity?.title ?? c.label ?? id)
        : isSession
          ? (c.focusSessionGoal ?? c.label ?? id)
          : (c.channelTitle ?? c.label ?? id),
      subtype: isEntity ? (c.entity?.type ?? null) : null,
      subtypes: isEntity
        ? [
            ...(c.entity?.type ? [c.entity.type] : []),
            ...(c.entity?.facetSlugs ?? []),
          ]
        : [],
      workspaceId: isEntity
        ? (c.entity?.workspaceId ?? null)
        : isSession
          ? (c.focusSessionWorkspaceId ?? null)
          : (c.channelWorkspaceId ?? null),
      edgeType:
        c.relationType ??
        c.propertySlug ??
        c.channelRelationshipType ??
        c.label,
      direction: c.direction,
      via: isEntity
        ? c.source === "graph"
          ? "relations"
          : "property"
        : isSession
          ? "session"
          : "channel",
    };
  });
}

/** Focus kinds whose grants live in `vault_grants` (the grantables + the
 * capability container that groups them). Matched by `grantableId = focusId`. */
const GRANTABLE_FOCUS_KINDS: ReadonlySet<string> = new Set([
  "capability",
  "tool",
  "skill",
  "command",
]);

/** The agent floor used to gate registry rows we surface as neighbours: SYSTEM
 * agents (shared built-ins) OR the caller's own agents — never another user's
 * private adjunct. Mirrors the `agent` branch in hydrateNodes. */
function agentFloor(userId: string) {
  return or(eq(agents.ownerType, "system"), ownAdjunctFilter(userId))!;
}

/**
 * The GOVERNANCE / OWNERSHIP neighbours of an infra object — bindings that live
 * in `vault_grants` (capability grants) and in the agent's channel/automation
 * ownership, NEITHER of which is mirrored into the `links` table. A read-time
 * fold (analogous to the entity-data fold), gated by focus kind:
 *
 *  - focus grantable (capability|tool|skill|command) → the AGENTS (or a
 *    workspace) GRANTED it. `vault_grants WHERE grantable_id = focus`
 *    (+ grantable_type when the focus is itself a grantable type). Each grant's
 *    `granted_to` is an agent-USER id; we map it → its `agents` REGISTRY row
 *    (agents.userId = granted_to) for display, dropping agents the caller can't
 *    see (agentFloor). Workspace-scoped grants (granted_to NULL) surface the
 *    workspace instead.
 *  - focus agent → the tools/skills/commands/secrets granted TO it
 *    (`vault_grants WHERE granted_to = <agent's agent-user id>`), PLUS the
 *    channels it is assigned to / an ai_agent member of, and the automations it
 *    created (`automations.createdBy = <agent-user id>`).
 *
 * Every far endpoint is hydrated through `hydrateNodes`, so it inherits the SAME
 * visibility floor as every other neighbour — an endpoint in a workspace the
 * caller can't see never hydrates and is dropped (no cross-workspace leak). The
 * driver queries (vault_grants / channels / automations rows) key off ids that
 * are not themselves user data; visibility is enforced at the hydration of the
 * endpoint we actually surface, exactly like getLinkNeighbors does for `links`.
 */
export async function getGovernanceNeighbors(
  userId: string,
  kind: string,
  id: string,
  facetVisibilityScope: FacetVisibilityScope,
  workspaceId?: string | null
): Promise<GraphNeighbor[]> {
  const isGrantableFocus = GRANTABLE_FOCUS_KINDS.has(kind);
  const isAgentFocus = kind === "agent";
  if (!isGrantableFocus && !isAgentFocus) return [];

  const db = await getDb();
  const out: GraphNeighbor[] = [];

  // ── A. Focus is a grantable → the agents/workspace granted it ───────────────
  if (isGrantableFocus) {
    const conds = [
      eq(vaultGrants.grantableId, id),
      isNull(vaultGrants.revokedAt),
    ];
    // Narrow by grantable_type when the focus kind IS a grantable type
    // (tool/skill/command) — guards against a cross-type id collision. A
    // `capability` focus has no grantable_type row (capabilities are containers,
    // not directly granted), so it matches nothing here — its member tools/skills
    // still surface via the existing `member_of` links.
    if ((GRANTABLE_TYPES as readonly string[]).includes(kind)) {
      conds.push(eq(vaultGrants.grantableType, kind as GrantableType));
    }
    const grants = await db
      .select()
      .from(vaultGrants)
      .where(and(...conds));

    const agentUserIds = [
      ...new Set(grants.map((g) => g.grantedTo).filter(Boolean) as string[]),
    ];
    // Resolve agent-USER id → agents REGISTRY row (scoped by agentFloor). An
    // agent-user with no visible registry row is dropped (we can't display it
    // and won't leak another user's agent id).
    const agentByUser = new Map<string, typeof agents.$inferSelect>();
    if (agentUserIds.length > 0) {
      const rows = await db
        .select()
        .from(agents)
        .where(and(inArray(agents.userId, agentUserIds), agentFloor(userId)));
      for (const a of rows) if (a.userId) agentByUser.set(a.userId, a);
    }

    // Workspace-scoped grants (granted_to NULL, workspace set) → workspace node.
    const wsIds = [
      ...new Set(
        grants
          .filter((g) => !g.grantedTo && g.workspaceId)
          .map((g) => g.workspaceId as string)
      ),
    ];
    const wsNodes = wsIds.length
      ? await hydrateNodes(
          userId,
          wsIds.map((w) => ({ kind: "workspace", id: w })),
          facetVisibilityScope,
          workspaceId
        )
      : new Map<string, GraphNode>();

    for (const g of grants) {
      if (g.grantedTo) {
        const a = agentByUser.get(g.grantedTo);
        if (!a) continue;
        out.push({
          kind: "agent",
          id: a.id,
          name: a.name,
          subtype: null,
          subtypes: [],
          workspaceId: null,
          edgeType: "granted_to",
          direction: "incoming",
          via: "grant",
        });
      } else if (g.workspaceId) {
        const node = wsNodes.get(`workspace:${g.workspaceId}`);
        if (!node) continue;
        out.push({
          ...node,
          edgeType: "granted_to",
          direction: "structural",
          via: "grant",
        });
      }
    }
  }

  // ── B. Focus is an agent → what it uses / is assigned to / created ──────────
  if (isAgentFocus) {
    // Resolve the focus agent (scoped) → its agent-USER id. If the caller can't
    // see the agent, run no folds.
    const [agentRow] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), agentFloor(userId)))
      .limit(1);
    if (!agentRow) return out;
    const agentUserId = agentRow.userId;

    // B1. Grants TO this agent (keyed on the agent-user id) → the grantables.
    if (agentUserId) {
      const grants = await db
        .select()
        .from(vaultGrants)
        .where(
          and(
            eq(vaultGrants.grantedTo, agentUserId),
            isNull(vaultGrants.revokedAt)
          )
        );
      const refs = grants.map((g) => ({
        kind: g.grantableType,
        id: g.grantableId,
      }));
      const nodes = await hydrateNodes(
        userId,
        refs,
        facetVisibilityScope,
        workspaceId
      );
      for (const g of grants) {
        const node = nodes.get(`${g.grantableType}:${g.grantableId}`);
        if (!node) continue;
        out.push({
          ...node,
          edgeType: "granted",
          direction: "outgoing",
          via: "grant",
        });
      }
    }

    // B2. Channels the agent is assigned to (channels.assignedAgentId = agent.id)
    // OR an ai_agent member of (channel_members, keyed on the agent-user id).
    const assignedRows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.assignedAgentId, id));
    const assignedIds = new Set(assignedRows.map((r) => r.id));
    let memberChannelIds: string[] = [];
    if (agentUserId) {
      const mems = await db
        .select({ channelId: channelMembers.channelId })
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.memberId, agentUserId),
            eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
          )
        );
      memberChannelIds = mems.map((m) => m.channelId);
    }
    const channelIds = [...new Set([...assignedIds, ...memberChannelIds])];
    if (channelIds.length > 0) {
      const chNodes = await hydrateNodes(
        userId,
        channelIds.map((cid) => ({ kind: "channel", id: cid })),
        facetVisibilityScope,
        workspaceId
      );
      for (const cid of channelIds) {
        const node = chNodes.get(`channel:${cid}`);
        if (!node) continue;
        out.push({
          ...node,
          edgeType: assignedIds.has(cid) ? "assigned_agent" : "channel_member",
          direction: "outgoing",
          via: "channel",
        });
      }
    }

    // B3. Automations the agent CREATED (automations.createdBy = agent-user id).
    // This is the owner-approved definition of agent→automations; the
    // "runs/governs" dimension has no stored link (see report).
    if (agentUserId) {
      const autoRows = await db
        .select({ id: automations.id })
        .from(automations)
        .where(eq(automations.createdBy, agentUserId));
      const autoIds = autoRows.map((r) => r.id);
      if (autoIds.length > 0) {
        const autoNodes = await hydrateNodes(
          userId,
          autoIds.map((aid) => ({ kind: "automation", id: aid })),
          facetVisibilityScope,
          workspaceId
        );
        for (const aid of autoIds) {
          const node = autoNodes.get(`automation:${aid}`);
          if (!node) continue;
          out.push({
            ...node,
            edgeType: "created",
            direction: "outgoing",
            via: "automation",
          });
        }
      }
    }
  }

  return out;
}

/**
 * How many events back the temporal fold reads for one object. The spine is
 * append-only and an active entity accrues events indefinitely, so the fold is
 * bounded by RECENCY, not by "everything" — the pane it feeds shows 5–7 rows and
 * a "show all". Distinct proposals/sessions are then capped independently below.
 */
const TEMPORAL_EVENT_SCAN_LIMIT = 200;
/** Max distinct proposal / session neighbours returned per focused object. */
const TEMPORAL_NEIGHBOR_CAP = 25;

/**
 * The TEMPORAL neighbours of any object — the "why" half of the graph.
 *
 * Every other neighbour source here answers WHAT an object is connected to.
 * None of them answers WHEN, or WHO AUTHORIZED IT, or WHAT THE PERSON WAS
 * TRYING TO DO — because none of that is a stored `links`/`relations` edge. It
 * is on the `events` spine, which has carried `subject_type`/`subject_id` (with
 * `idx_events_subject`), `proposal_id` (0231) and now `session_id` (0241).
 *
 * So this is a read-time fold, exactly like the entity-data and governance folds:
 *
 *   events WHERE (subject_type, subject_id) = focus      ← one indexed scan
 *     → proposals via events.proposal_id                  ← via: "governed"
 *     → sessions  via events.session_id                   ← via: "produced-in"
 *                  and via proposals.session_id           ← (pre-0241 rows)
 *
 * Both neighbour classes are BACKWARD-looking (`direction: "incoming"`): they
 * are things that acted ON the focused object.
 *
 * ── VISIBILITY ──────────────────────────────────────────────────────────────
 * The driver scan floors on `events.user_id` — the events spine is per-user, and
 * an event row is the only thing naming the proposal/session ids at all, so an
 * owner floor here means a caller can never enumerate another user's ids. On top
 * of that:
 *   - proposals are re-floored with `userVisibleWhere` (their registered rule),
 *   - sessions hydrate through `hydrateNodes`, whose `session` branch is the
 *     owner-aware `ownerPrivateVisibleWhere` floor + the workspace lens.
 * A row that fails either floor is DROPPED, never surfaced as a bare id.
 *
 * FORWARD effects of a session (produced / targets / used) are NOT re-fetched
 * here: `getLinksFor` already returns edges in both directions, so a session
 * focus already lists them via `via: "links"`. Duplicating them would double-count.
 */
export async function getTemporalNeighbors(
  userId: string,
  kind: string,
  id: string,
  facetVisibilityScope: FacetVisibilityScope,
  workspaceId?: string | null
): Promise<GraphNeighbor[]> {
  const db = await getDb();

  // ONE indexed scan (idx_events_subject), newest first, owner-floored.
  const rows = await db
    .select({
      proposalId: events.proposalId,
      sessionId: events.sessionId,
      timestamp: events.timestamp,
    })
    .from(events)
    .where(
      and(
        eq(events.subjectType, kind),
        eq(events.subjectId, id),
        eq(events.userId, userId),
        or(isNotNull(events.proposalId), isNotNull(events.sessionId))
      )
    )
    .orderBy(desc(events.timestamp))
    .limit(TEMPORAL_EVENT_SCAN_LIMIT);
  if (rows.length === 0) return [];

  const proposalIds = [
    ...new Set(rows.map((r) => r.proposalId).filter(Boolean) as string[]),
  ].slice(0, TEMPORAL_NEIGHBOR_CAP);
  const sessionIds = new Set(
    rows.map((r) => r.sessionId).filter(Boolean) as string[]
  );

  const out: GraphNeighbor[] = [];

  // ── Proposals: the governance decisions that touched this object ───────────
  if (proposalIds.length > 0) {
    const proposalRows = await db
      .select({
        id: proposals.id,
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
        status: proposals.status,
        workspaceId: proposals.workspaceId,
        sessionId: proposals.sessionId,
      })
      .from(proposals)
      .where(
        and(
          inArray(proposals.id, proposalIds),
          // The `proposalIds` fed in already came from `events` filtered on
          // `events.userId = userId`, so these are the caller's own decisions —
          // LENS **or** OWNERSHIP, else the object's own history had holes.
          or(
            userVisibleWhere(proposals.workspaceId, userId),
            authoredByUser(userId)
          )
        )
      );
    for (const p of proposalRows) {
      // Pre-0241 rows carry no `events.session_id`; the proposal itself often
      // does, so it is the second (older) route to the same session.
      if (p.sessionId) sessionIds.add(p.sessionId);
      out.push({
        kind: "proposal",
        id: p.id,
        // NEVER a hand-written label map — the one vocabulary door. Past mood:
        // this is history, something that already happened to the object.
        name: buildObjectActionTitle({
          action: p.proposalType,
          objectKind: p.targetType,
          mood: "past",
        }),
        subtype: p.status,
        subtypes: [p.status],
        workspaceId: p.workspaceId,
        edgeType: p.proposalType,
        direction: "incoming",
        via: "governed",
      });
    }
  }

  // ── Sessions: the goal-bound work the change happened inside ──────────────
  const sessionIdList = [...sessionIds].slice(0, TEMPORAL_NEIGHBOR_CAP);
  if (sessionIdList.length > 0) {
    const nodes = await hydrateNodes(
      userId,
      sessionIdList.map((sid) => ({ kind: "session", id: sid })),
      facetVisibilityScope,
      workspaceId
    );
    for (const sid of sessionIdList) {
      // The focused object IS this session — a session is not its own neighbour.
      if (kind === "session" && sid === id) continue;
      const node = nodes.get(`session:${sid}`);
      // Not visible to this caller (another user's session, or outside the
      // lens) → dropped. Never surface a bare id.
      if (!node) continue;
      out.push({
        ...node,
        edgeType: "produced_in",
        direction: "incoming",
        via: "produced-in",
      });
    }
  }

  return out;
}

/** Max entities returned as the "body of" neighbours of one document. */
const DOCUMENT_BODY_NEIGHBOR_CAP = 25;

/**
 * The ENTITIES that use this document as their body — the reverse of
 * `entities.documentId`, a plain FK column that is NEVER mirrored into
 * `links` or `relations`. Every other fold in this file answers "what edge
 * connects to X"; none of them see this one, because it isn't a `links` row —
 * so a `document` focus resolved to zero neighbours even when live entities
 * pointed at it (the forward direction — entity → its body document — is
 * already visible on the entity's own detail payload as `documentId`; this
 * closes only the missing reverse).
 *
 * Gated on `kind === "document"` — every other focus kind pays nothing.
 * Floored through the SAME canonical entity read-scope (`accessScopeWhere`,
 * `facetLens: true`) that `hydrationScopeWhere`'s `"entity"` branch uses for
 * every other entity neighbour in this graph, so an entity in a workspace (or
 * behind a facet lens) this caller can't see is dropped, never leaked by name.
 */
export async function getDocumentBodyNeighbors(
  userId: string,
  kind: string,
  id: string,
  facetVisibilityScope: FacetVisibilityScope,
  workspaceId?: string | null
): Promise<GraphNeighbor[]> {
  if (kind !== "document") return [];

  const db = await getDb();
  const rows = await db
    .select({
      id: entities.id,
      title: entities.title,
      type: entities.type,
      workspaceId: entities.workspaceId,
    })
    .from(entities)
    .where(
      and(
        eq(entities.documentId, id),
        isNull(entities.deletedAt),
        accessScopeWhere({
          workspaceIdColumn: entities.workspaceId,
          entityIdColumn: entities.id,
          ownerColumn: entities.userId,
          userId,
          workspaceLens: workspaceId,
          facetLens: true,
        })
      )
    )
    .limit(DOCUMENT_BODY_NEIGHBOR_CAP);
  if (rows.length === 0) return [];

  // Facet slugs on top of the base type, exactly like `hydrateNodes`' entity
  // branch — an entity's `subtypes` always means "[kind slug, ...facet slugs]",
  // never just the kind slug, so this fold must not shortcut that.
  const facetSlugsByEntity = await loadFacetSlugs(
    db,
    rows.map((r) => r.id),
    facetVisibilityScope
  );

  return rows.map((r) => ({
    kind: "entity",
    id: r.id,
    name: r.title ?? "(untitled)",
    subtype: r.type ?? null,
    subtypes: [
      ...(r.type ? [r.type] : []),
      ...(facetSlugsByEntity.get(r.id) ?? []),
    ],
    workspaceId: r.workspaceId,
    edgeType: "documentId",
    direction: "incoming",
    via: "body",
  }));
}

/**
 * Merge every neighbour source into ONE list, de-duplicated.
 *
 * Two de-dup rules, and the second is the one live dogfood found:
 *
 *  1. **Same edge, twice** — de-dup on `(kind, id, edgeType, via)`, so an object
 *     linked twice the same way isn't double-counted.
 *
 *  2. **One fact, two rows** — a session that PRODUCED the focused object is
 *     already a stored `links` edge (`edgeType: "produced"`, `via: "links"`).
 *     The temporal fold independently derives the same session from the events
 *     spine and emits it as `produced_in` / `via: "produced-in"`. Both rows name
 *     the same session and the same fact, so the DERIVED one is dropped: the
 *     stored edge is primary. The temporal row SURVIVES when no `produced` link
 *     exists for that session — e.g. an update made inside a session, which
 *     creates no `produced` link and whose only trace is the events spine.
 *
 * Order matters: `linkNeighbors` must come before `temporalNeighbors` so the
 * stored edge is the one that lands.
 */
export function mergeNeighbors(
  sources: readonly GraphNeighbor[][]
): GraphNeighbor[] {
  const all = sources.flat();

  // Sessions already asserted as producers by a STORED link edge.
  const producedByLink = new Set(
    all
      .filter(
        (n) =>
          n.kind === "session" && n.edgeType === "produced" && n.via === "links"
      )
      .map((n) => n.id)
  );

  const seen = new Set<string>();
  const neighbors: GraphNeighbor[] = [];
  for (const n of all) {
    if (
      n.via === "produced-in" &&
      n.kind === "session" &&
      producedByLink.has(n.id)
    ) {
      continue;
    }
    const key = `${n.kind}:${n.id}:${n.edgeType}:${n.via}`;
    if (seen.has(key)) continue;
    seen.add(key);
    neighbors.push(n);
  }
  return neighbors;
}

/**
 * Assemble the uniform envelope: the focused object (hydrated) + its neighbours.
 * `extraNeighbors` lets the route layer fold in the ENTITY-DATA graph
 * (relations + property + channel from `getConnections`) for entity kinds —
 * that half needs the tRPC ctx, so it's injected, not fetched here.
 */
export async function getObjectGraph(
  userId: string,
  kind: LinkEndpointType,
  id: string,
  extraNeighbors: GraphNeighbor[] = [],
  workspaceId?: string | null
): Promise<GraphEnvelope> {
  const facetVisibilityScope = await resolveFacetVisibilityScope(
    userId,
    workspaceId
  );
  const [
    selfMap,
    linkNeighbors,
    governanceNeighbors,
    temporalNeighbors,
    documentBodyNeighbors,
  ] = await Promise.all([
    hydrateNodes(userId, [{ kind, id }], facetVisibilityScope, workspaceId),
    getLinkNeighbors(userId, kind, id, facetVisibilityScope, workspaceId),
    getGovernanceNeighbors(userId, kind, id, facetVisibilityScope, workspaceId),
    getTemporalNeighbors(userId, kind, id, facetVisibilityScope, workspaceId),
    getDocumentBodyNeighbors(
      userId,
      kind,
      id,
      facetVisibilityScope,
      workspaceId
    ),
  ]);

  // Merge config + data graphs through the ONE de-dup door (see `mergeNeighbors`:
  // same-edge-twice, plus the produced / produced-in one-fact-two-rows fold).
  const neighbors = mergeNeighbors([
    linkNeighbors,
    governanceNeighbors,
    temporalNeighbors,
    documentBodyNeighbors,
    extraNeighbors,
  ]);

  // Resolve the focal node. `hydrateNodes` already gives stub kinds
  // (`participant`/`source` — no KIND_TABLE) a raw-id node, so a MISS here means
  // a TABLE-BACKED id that hydrated to nothing: it genuinely doesn't exist, or
  // isn't visible to this caller. Only fabricate a placeholder when ≥1 visible
  // edge corroborates the node (a real graph citizen the user can partially see);
  // otherwise signal not-found so callers don't render a phantom entity named by
  // its own UUID.
  const hydrated = selfMap.get(`${kind}:${id}`);
  const found = hydrated !== undefined || neighbors.length > 0;
  const object: GraphNode = hydrated ?? {
    kind,
    id,
    name: found ? id : "(not found)",
    subtype: null,
    subtypes: [],
    workspaceId: null,
  };

  const byKind: Record<string, number> = {};
  const byVia: Record<string, number> = {};
  for (const n of neighbors) {
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
    byVia[n.via] = (byVia[n.via] ?? 0) + 1;
  }

  return {
    object,
    neighbors,
    counts: { total: neighbors.length, byKind, byVia },
    found,
  };
}

/**
 * Name-addressing — resolve an object by its NAME (a handle), not its uuid.
 * Names aren't unique pod-wide, so this returns ALL matches (the caller / agent
 * disambiguates by subtype or count). Reuses the same KIND_TABLE registry as
 * hydration — one source of truth for "what column is this kind's name". Scoped
 * via `userVisibleWhere` so you can only resolve names you may see.
 *
 * `subtype` narrows further (entity profileSlug, view type, tool/skill kind).
 * Case-insensitive exact match on the name column. Stub kinds (no table) → [].
 * The `entity` kind is ownerPrivate, so it floors on the entity READ scope
 * (`accessScopeWhere`) — config kinds stay on the pod-wide `userVisibleWhere`.
 */
export async function resolveByName(
  userId: string,
  kind: string,
  name: string,
  subtype?: string,
  limit = 10
): Promise<GraphNode[]> {
  const spec = KIND_TABLE[kind];
  if (!spec) return [];
  const t = spec.table;
  const db = await getDb();

  const conds = [
    // `entities` is ownerPrivate — a bare `userVisibleWhere` here admits pod-wide
    // NULL-workspace rows to ALL users, leaking another tenant's entity NAME by a
    // name guess. Floor the entity kind on the canonical entity READ scope
    // (owner-gated NULL + membership + exposure + role-lens), like entities.list.
    // Config kinds (tools/playbooks/relationDefs…) stay podGlobalConfig, so their
    // NULL rows correctly remain pod-wide visible via `userVisibleWhere`.
    kind === "entity"
      ? accessScopeWhere({
          workspaceIdColumn: entities.workspaceId,
          entityIdColumn: entities.id,
          ownerColumn: entities.userId,
          userId,
          facetLens: true,
        })
      : userVisibleWhere(t.workspaceId, userId),
    ilike(t[spec.name], name),
  ];
  if (subtype && spec.subtype) conds.push(eq(t[spec.subtype], subtype));

  const rows = await db
    .select()
    .from(t)
    .where(and(...conds))
    .limit(limit);

  return (rows as Record<string, unknown>[]).map((row) => {
    const rowSubtype = spec.subtype
      ? ((row[spec.subtype] as string | null) ?? null)
      : null;
    return {
      kind,
      id: row.id as string,
      name: (row[spec.name] as string | null) ?? "(untitled)",
      subtype: rowSubtype,
      subtypes: rowSubtype ? [rowSubtype] : [],
      workspaceId: (row.workspaceId as string | null) ?? null,
    };
  });
}

/**
 * Resolve a NAME to profile/role *types* (not entities). The meta-model dual of
 * `resolveByName`: KIND_TABLE only knows entity/object kinds (entity, view,
 * channel, ...), so a caller who types a profile slug (e.g. `client`, `person`)
 * into a graph lookup dead-ends. This probes the `profiles` table so the caller
 * can be routed to the right tool (list_profiles / attach_facet / define_role)
 * instead of getting a bare "not found".
 *
 * Case-insensitive match on slug OR displayName (same intent as `resolveByName`'s
 * `ilike`), scoped through the canonical `getAccessibleProfiles` visibility floor
 * (SYSTEM + USER + the caller's member-workspace profiles) so a caller only
 * resolves profile types it may see.
 */
export async function resolveProfileByName(
  userId: string,
  name: string,
  limit = 5
): Promise<
  Array<{
    slug: string;
    displayName: string;
    profileKind: "kind" | "role";
    applicableKinds: string[] | null;
  }>
> {
  const db = await getDb();
  const repo = new ProfileRepository(db);
  // Workspace-less floor: SYSTEM + USER + member-workspace profiles — reuse the
  // profile router's canonical predicate rather than re-deriving scope here.
  const accessible = await repo.getAccessibleProfiles(userId, "");
  const needle = name.toLowerCase();
  return accessible
    .filter(
      (p) =>
        p.slug.toLowerCase() === needle ||
        p.displayName.toLowerCase() === needle
    )
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      displayName: p.displayName,
      profileKind: (p.profileKind ?? "kind") as "kind" | "role",
      applicableKinds: p.applicableKinds ?? null,
    }));
}
