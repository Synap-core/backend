/**
 * Proposal snoozes — "Later" on a request (0381, founder decision G3).
 *
 * One person sets one pending request aside until a time. It changes nothing
 * about governance and nothing for anyone else: the needs-you rule reads it as
 * Review later for THAT reader only (`classifyPendingProposal`), and the
 * request comes back on its own when the time passes. One row per
 * (proposal, person); a later "Later" moves the time; deleted with its
 * proposal. Access rule: `user` on `userId` (`access/registry.ts`).
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { proposals } from "./proposals.js";

export const proposalSnoozes = pgTable(
  "proposal_snoozes",
  {
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    snoozedUntil: timestamp("snoozed_until", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.proposalId, table.userId] }),
    userIdx: index("proposal_snoozes_user_idx").on(
      table.userId,
      table.snoozedUntil
    ),
  })
);

export type ProposalSnooze = typeof proposalSnoozes.$inferSelect;
