/**
 * One row per raised STATUS SIGNAL episode (0376, status-flow W6): the
 * watcher claims (subject, signal, episode) here before it raises the
 * derived event, so an episode is raised once, race-free. The `events`
 * hypertable cannot carry this unique key (its key includes the timestamp).
 */
import { pgTable, text, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const statusSignalRaised = pgTable(
  "status_signal_raised",
  {
    subjectType: text("subject_type").notNull(),
    /** The facet for a role's lifecycle, else the subject. */
    subjectId: text("subject_id").notNull(),
    signal: text("signal").notNull(),
    /** What ends the episode when it changes (the watcher's anchor). */
    episodeKey: text("episode_key").notNull(),
    raisedAt: timestamp("raised_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.subjectType, t.subjectId, t.signal, t.episodeKey],
    }),
  })
);
