/**
 * Durable, per-user progress for a contextual onboarding journey.
 *
 * A lens key is denormalized alongside its workspace/project identifiers so
 * PostgreSQL can enforce one journey per user, lens, and template version even
 * when one or both optional identifiers are NULL.
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
import { workspaces } from "./workspaces.js";
import { projects } from "./projects.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export type OnboardingJourneyLensKind =
  "pod" | "workspace" | "project" | "project_workspace";

export type OnboardingJourneyStatus =
  "offered" | "active" | "paused" | "completed" | "dismissed";

export interface OnboardingJourneyProgressRecord {
  currentActionId?: string;
  completedActionIds: string[];
  values: Record<string, unknown>;
}

export interface OnboardingJourneyEvidenceRecord {
  meaningfulEntityIds: string[];
  completedCriteria: string[];
  firstValueAt?: string;
}

export const onboardingJourneys = pgTable(
  "onboarding_journeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    lensKind: text("lens_kind", {
      enum: ["pod", "workspace", "project", "project_workspace"],
    })
      .$type<OnboardingJourneyLensKind>()
      .notNull(),
    lensKey: text("lens_key").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    templateVersion: text("template_version").notNull().default("1"),
    status: text("status", {
      enum: ["offered", "active", "paused", "completed", "dismissed"],
    })
      .$type<OnboardingJourneyStatus>()
      .notNull()
      .default("offered"),
    progress: jsonb("progress")
      .$type<OnboardingJourneyProgressRecord>()
      .notNull()
      .default({ completedActionIds: [], values: {} }),
    evidence: jsonb("evidence")
      .$type<OnboardingJourneyEvidenceRecord>()
      .notNull()
      .default({ meaningfulEntityIds: [], completedCriteria: [] }),
    offeredAt: timestamp("offered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userLensVersionUnique: uniqueIndex(
      "onboarding_journeys_user_lens_version_unique"
    ).on(table.userId, table.lensKey, table.templateVersion),
    userStatusIndex: index("onboarding_journeys_user_status_idx").on(
      table.userId,
      table.status
    ),
    workspaceIndex: index("onboarding_journeys_workspace_id_idx").on(
      table.workspaceId
    ),
    projectIndex: index("onboarding_journeys_project_id_idx").on(
      table.projectId
    ),
  })
);

export type OnboardingJourney = typeof onboardingJourneys.$inferSelect;
export type NewOnboardingJourney = typeof onboardingJourneys.$inferInsert;
export const insertOnboardingJourneySchema =
  createInsertSchema(onboardingJourneys);
export const selectOnboardingJourneySchema =
  createSelectSchema(onboardingJourneys);
