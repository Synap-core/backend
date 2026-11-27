/**
 * Frame drafts — who owns a draft id the frame read door answered for.
 * Migration 0463.
 *
 * A person's own unsaved draft (a preview, `{kind: "draft", draftId}`) is
 * named by an id its host chose. The first person whose read the door
 * answered for that id claims it here, in one insert on the primary key, and
 * keeps it: anyone else naming it is refused (`FRAME_DRAFT_NOT_YOURS`). The
 * claim is not kept in `frame_read_log`, whose rows the retention deletes.
 *
 * Written only by `services/surfaces/frame-read.ts`. No foreign key: a claim
 * names an id no other table stores.
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const frameDrafts = pgTable("frame_drafts", {
  /** The host's draft id. */
  draftId: text("draft_id").primaryKey(),
  /** The person who owns it. */
  userId: text("user_id").notNull(),
  claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});
