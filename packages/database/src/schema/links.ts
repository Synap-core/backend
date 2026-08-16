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
  // `project` entity profile — this is NOT an entity id). Two edges use it:
  //   session --targets--> project   (session scoped to a container)
  //   project --targets--> entity    (the container's SUBJECT — the real-world
  //                                   thing it is about; drives the UI noun)
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
  | "workspace";

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
   * SUMMARY, not a merge. The UI says "forked from"; it never draws a graph.
   */
  | "spawned_from"
  // dynamic tool-auth binding: principal|entity --provides_credential--> secret.
  // metadata.toolId scopes the credential to a specific tool. Resolved at
  // execution by the dispatcher per the tool's `authBinding`.
  | "provides_credential";

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
