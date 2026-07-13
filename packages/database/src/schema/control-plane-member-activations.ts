/**
 * Control Plane member-activation receipts.
 *
 * The Control Plane is responsible for invitation and retry orchestration.
 * This Pod-local table only records a successfully projected command so a
 * retry cannot create a second identity or membership.
 */
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

export const controlPlaneMemberActivations = pgTable(
  "control_plane_member_activations",
  {
    activationId: text("activation_id").primaryKey(),
    controlPlaneUserId: text("control_plane_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    role: text("role").notNull(),
    activatedAt: timestamp("activated_at", {
      mode: "date",
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  }
);

export type ControlPlaneMemberActivation =
  typeof controlPlaneMemberActivations.$inferSelect;
