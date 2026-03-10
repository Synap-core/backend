/**
 * Intelligence Commands Schema
 *
 * User-created Commands (Raycast-style): prompt template + derived inputs + permissions.
 * Single source of truth: prompt_template; compiled_template_ast and derived_inputs from parser.
 */
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
export const intelligenceCommands = pgTable(
  "intelligence_commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull(), // user_id
    title: text("title").notNull(),
    /** Source of truth; parser produces compiled_template_ast + derived_inputs */
    promptTemplate: text("prompt_template").notNull(),
    compiledTemplateAst: jsonb("compiled_template_ast").$type(),
    derivedInputs: jsonb("derived_inputs").$type(),
    /** Optional overrides: labels, defaults, options only */
    inputOverrides: jsonb("input_overrides").$type(),
    /** Permission model */
    allowedTools: jsonb("allowed_tools").$type(),
    allowedEntityTypes: jsonb("allowed_entity_types").$type(),
    maxEntitiesCreatedPerRun: integer("max_entities_created_per_run"),
    canCreateViews: boolean("can_create_views").default(false).notNull(),
    outputMode: text("output_mode", {
      enum: ["text", "proposal", "view"],
    })
      .notNull()
      .default("text"),
    permissionsProfile: text("permissions_profile", {
      enum: ["read_only", "propose_writes"],
    })
      .notNull()
      .default("propose_writes"),
    sharedScope: text("shared_scope", { enum: ["workspace", "user"] })
      .notNull()
      .default("workspace"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceIdIdx: index("intelligence_commands_workspace_id_idx").on(
      table.workspaceId
    ),
    createdByIdx: index("intelligence_commands_created_by_idx").on(
      table.createdBy
    ),
  })
);
//# sourceMappingURL=intelligence-commands.js.map
