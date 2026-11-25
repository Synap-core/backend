/**
 * Frame read log — one row per read a framed surface asked the pod's frame
 * read door for (`surfaces.frameRead`, Hub `POST /frame/read`), answered or
 * refused. Migration 0456.
 *
 * What it records: which surface asked (`surface_kind` cell | document, and
 * its key: the cell's type key or the document's id), the op, a sha256 of the
 * params the door forwarded (never the values: a param can be an id the
 * viewer may not want kept in clear), whether the surface DECLARES its reads
 * (`declared`) and whether the read was ALLOWED. A refused read is logged
 * before the refusal is answered; an allowed one before it runs.
 *
 * Read by the Inspect lane (P7) to show what a page or a cell read. An append
 * log: no foreign key (a row outlives the surface and the person it names,
 * like an audit line), written only by `services/surfaces/frame-read.ts`.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const frameReadLog = pgTable(
  "frame_read_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The viewer the read ran as. */
    userId: text("user_id").notNull(),
    /** The space the host stamped (its lens), null for a personal page. */
    workspaceId: uuid("workspace_id"),
    /** `cell` | `document`. */
    surfaceKind: text("surface_kind").notNull().$type<"cell" | "document">(),
    /** The cell type key, or the document id. */
    surfaceKey: text("surface_key").notNull(),
    op: text("op").notNull(),
    /** sha256 (hex) of the forwarded params, canonical JSON (sorted keys). */
    paramsHash: text("params_hash").notNull(),
    allowed: boolean("allowed").notNull(),
    /** False when the surface declares no reads (the default-allowed path). */
    declared: boolean("declared").notNull(),
    at: timestamp("at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    surfaceIdx: index("frame_read_log_surface_idx").on(
      table.surfaceKind,
      table.surfaceKey,
      table.at
    ),
    userIdx: index("frame_read_log_user_idx").on(table.userId, table.at),
  })
);

export type FrameReadLogRow = typeof frameReadLog.$inferSelect;
