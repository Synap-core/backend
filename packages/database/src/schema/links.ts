/**
 * Links Schema — the config/runtime graph edges
 *
 * A polymorphic edge between CONFIGURATION/RUNTIME objects (playbook · tool ·
 * skill · command · session · source) and, where useful, entity DATA. This is
 * the deliberate mirror of the entity `relations` table — `relations` is the
 * graph for entity DATA; `links` is the graph for everything else — keeping the
 * data/config separation clean while still letting config point at data.
 *
 * ONE table powers every detail page's "related" panel and the capability graph:
 * `SELECT * FROM links WHERE (from_type,from_id)=$ OR (to_type,to_id)=$`.
 *
 * Edge semantics (linkType):
 *   playbook            --grants-->            tool | skill | command
 *   skill               --requires-->          tool
 *   command             --requires-->          tool        (command tool deps)
 *   session             --instantiated_from--> playbook
 *   session             --used-->              tool | skill (run provenance)
 *   session             --targets-->           entity       (e.g. a linked task)
 *   session             --produced-->          entity       (run output)
 *   session             --promoted_to-->       playbook     (promotion lineage)
 *   source              --feeds-->             playbook     (input-strategy source)
 *   tool                --provided_by-->       source       (tool backed by a provider)
 *   participant|channel --member_of-->         session      (room participants)
 *   project             --uses-->              workspace    (INDEX of domains an engagement runs through; NOT an ACL)
 *   participant(agent)  --dispatched_via-->    tool         (BINDING: how the pod hands this agent work — tools.config.agentBinding)
 *   entity(knowledge)   --about-->             tool | skill (knowledge↔config bridge)
 *   entity(knowledge)   --documents-->         tool | skill (knowledge↔config bridge)
 *   entity(knowledge)   --concerns-->          playbook|... (knowledge↔config bridge)
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * The kind of object on either end of a link edge.
 * `participant` = a user-id OR agent-user-id (both live in the `users` table).
 */
export type LinkEndpointType =
  | "playbook"
  | "tool"
  | "skill"
  | "command"
  | "session"
  | "source"
  | "entity"
  | "channel"
  | "participant"
  // An automation scoped to a playbook: `automation --member_of--> playbook`.
  // The matcher resolves a produced entity's session → playbook → these
  // automations, so playbook automations fire for their session's entities.
  | "automation"
  // A row of the `projects` TABLE (migration 0151 consolidated projects off the
  // `project` entity profile — this is NOT an entity id). Edges that use it:
  //   session --targets--> project   (session scoped to a container)
  //   project --targets--> entity    (the container's SUBJECT — the real-world
  //                                   thing it is about; drives the UI noun)
  //   project --uses--> workspace    (INDEX of domains the engagement runs
  //                                   through; NOT an ACL — see LinkType)
  | "project"
  // A vault secret, as the TARGET of a `provides_credential` edge (dynamic
  // tool auth binding: a principal/entity provides the credential for a tool).
  | "secret"
  // A capability CONTAINER (`capabilities` table). Parts attach as members:
  // `tool|skill|command --member_of--> capability` (mirrors automation→playbook).
  | "capability"
  // An AI agent (the `agents` REGISTRY row) — a graph citizen so the object-graph
  // door resolves an agent's grants/channels/automations. In lock-step with the
  // @synap/playbooks LinkEndpointType union.
  | "agent"
  // A workspace (lens). `workspace --feeds--> workspace` = provider→consumer
  // lens propagation; `workspace --requires--> workspace` = install dependency.
  // Governs lens propagation only — never data movement (see links.ts header).
  | "workspace"
  // A `documents` row — the raw capture (an intake source staged by
  // `stageIntakeSource`). `document --produced--> entity` = "this capture made
  // that entity". SYSTEM-WRITTEN ONLY, by `stampMaterialized`; the Hub REST
  // door reads it but refuses to create it.
  | "document"
  // A `project_tracks` row — a METHOD running inside a project (0272). Its own
  // structure (project, sessions via `focus_sessions.track_id`, playbook) is
  // read from FK columns by the object graph; as a links endpoint it can carry
  // dependency / provenance edges like any other unit of work. Visible exactly
  // when its parent project is (`link-endpoint-visibility.ts`).
  | "track";

// ── `governance_rule` was HERE and was removed, deliberately ────────────────
// It was added so an intent-rule could hold an edge to the governance rule it
// produced (`automation|playbook --produced--> governance_rule`). No such
// producer exists, and no reader does either: `rg 'Type: "governance_rule"'`
// across every repo returns nothing but a proposal `targetType`, which is a
// different axis.
//
// The same wave that added it spent its main effort deleting the `activates`
// edge's decorative half, on the principle that a write with no reader is not a
// store. An endpoint type with neither is that principle's own counterexample —
// and because it was allowlisted for Hub REST writes, an agent could have
// created edges nothing was able to interpret.
//
// Re-add it WITH its producer, not before. That is three lines (this union, the
// dependency-free mirror in `@synap/playbooks`, the REST allowlist), and
// `links-endpoint-type-ssot.test.ts` DISCOVERS those sites by scanning source,
// so nothing can be missed.
//
// ⚠️ THAT TRIPWIRE COVERS `LinkEndpointType` ONLY. This paragraph used to read
// as though it guarded both unions; it never did, and while it said so the
// `LinkType` allowlist in the Hub REST door sat FOUR members behind this file
// (`blocked_by`, `spawned_from`, `activates`, `provides_credential`), which
// meant an IS agent — whose only door to the pod is Hub Protocol — could not
// declare that one unit of work blocks another. `LinkType` now has a tripwire of
// its own, `__tripwires__/links-type-ssot.test.ts`, which additionally derives
// which members are LIVE (something produces or reads them) so the write
// allowlist tracks reality rather than symmetry.

/** The relationship an edge expresses. */
export type LinkType =
  | "grants"
  | "requires"
  | "instantiated_from"
  | "used"
  | "targets"
  | "produced"
  | "member_of"
  | "feeds"
  | "promoted_to"
  | "provided_by"
  // knowledge↔config bridge edges (entity DATA pointing at config objects)
  | "about"
  | "documents"
  | "concerns"
  // automation → playbook activation edge (Process North Star Wave 0)
  | "activates"
  /**
   * session --spawned_from--> session. Work lineage: this session was forked
   * from that one.
   *
   * Deliberately NOT called "branched_from", and there is deliberately no
   * "merged_into" twin. Git's branch/merge model is a researched conceptual
   * defect, and no comparable system merges units of work — the pattern that
   * actually ships is a coordinator with sibling children, where fan-in is a
   * SUMMARY, not a merge. The room says "forked from". Since 2026-09-22
   * (founder decision) the desktop WORK MAP does draw these edges — lanes on
   * a time axis, spawn and `blocked_by` lines only, never a merge line.
   */
  | "spawned_from"
  // dynamic tool-auth binding: principal|entity --provides_credential--> secret.
  // metadata.toolId scopes the credential to a specific tool. Resolved at
  // execution by the dispatcher per the tool's `authBinding`.
  | "provides_credential"
  /**
   * X --blocked_by--> Y. THE dependency between units of work, across kinds
   * (`session` · `entity` · `track`, any pair — `DEPENDENCY_ENDPOINT_KINDS` in
   * `@synap-core/types/connections`): the FROM end cannot proceed until the TO
   * end clears by its own kind's status vocabulary. Entity relations
   * `blocks` / `depends_on` are this edge under other names; the relation
   * create door maps them here and migration 0301 moved the stored rows.
   *
   * Blocked-ness is DERIVED from the subset of these edges whose TARGET is
   * still open, never a stored `blocked` status on `focus_sessions` (prior
   * art: Atlassian's "flag, don't status" — a status can only hold one value,
   * so storing blocked-ness destroys the real state and then drifts from the
   * blockers). The ONE producer is `services/links/dependency-links.ts`
   * (session↔session through `session-blocked-by.ts`'s owner floor); the rule
   * is `deriveOpenBlockers`.
   *
   * Unrelated to the run status `blocked_by_policy` — that is a governance
   * outcome on a single run, not an edge between sessions.
   */
  | "blocked_by"
  /**
   * A --replaces--> B. "This step replaces that one" — B failed or was dropped
   * and A is the attempt instead. Same endpoint kinds and producer as
   * `blocked_by`. Read by the node neighbourhood (Related: "Replaces" /
   * "Replaced by") and by `deriveOpenBlockers`: whoever waited on B now waits
   * on A, so a replaced step can neither hold its dependents forever nor clear
   * them early.
   */
  | "replaces"
  /**
   * project --uses--> workspace. INDEX of which domains (workspaces) an
   * engagement runs through. Stamped at provision time so a clean template
   * install (zero seed entities) still answers "which workspaces does this
   * project use?" / "which projects use this workspace?".
   *
   * NOT an ACL: project members do NOT gain workspace membership from this
   * edge. Entity membership stays `belongs_to_project` on the relations table.
   * Distinct from live `used` (session --used--> tool, run provenance).
   */
  | "uses"
  /**
   * participant(agentUserId) --dispatched_via--> tool(toolId). The BINDING of an
   * EXTERNAL agent identity (a `users.userType='agent'` row that works through
   * its own door key) to the tool the pod hands it work through: a `tools` row
   * with `kind:'external'`, `executor:'external-agent'` and a validated
   * `config.agentBinding` ({ protocol, provider, supports, verbs }). AT MOST ONE
   * per agent. Its existence is what makes an agent's reach `'dispatch'`
   * (`resolveAgentReach`); its content is read ONLY through
   * `resolveAgentBinding` (`services/agent-dispatch/agent-binding.ts`).
   *
   * HUMAN-WRITTEN ONLY, through `agentUsers.setBinding` — an agent that could
   * write this edge could re-point its own dispatch at a tool of its choosing.
   * The Hub REST links door lists it (the type-SSOT tripwire requires every
   * produced type there) and refuses it explicitly.
   */
  | "dispatched_via";

export const links = pgTable(
  "links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nullable = pod-wide. */
    workspaceId: uuid("workspace_id"),
    fromType: text("from_type").$type<LinkEndpointType>().notNull(),
    /** Polymorphic id (uuid or string id, depending on endpoint kind). */
    fromId: text("from_id").notNull(),
    toType: text("to_type").$type<LinkEndpointType>().notNull(),
    toId: text("to_id").notNull(),
    linkType: text("link_type").$type<LinkType>().notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    /** Owning principal — human or agent-user id. Nullable for system edges. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    fromIdx: index("idx_links_from").on(table.fromType, table.fromId),
    toIdx: index("idx_links_to").on(table.toType, table.toId),
    typeIdx: index("idx_links_type").on(table.linkType),
    uniqueEdge: uniqueIndex("idx_links_unique_edge").on(
      table.fromType,
      table.fromId,
      table.toType,
      table.toId,
      table.linkType
    ),
  })
);

export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
export const insertLinkSchema = createInsertSchema(links);
export const selectLinkSchema = createSelectSchema(links);
