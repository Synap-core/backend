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
  | "automation";

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
  | "concerns";

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
