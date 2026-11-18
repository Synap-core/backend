/**
 * Realtime room tickets (0433): how a pod APP opens a live Yjs room.
 *
 * A pod app holds its person's connection token (an `app_person` api key) on
 * its own server, never in the browser. To open a document's live room from
 * the browser it trades that token for a ticket (`POST
 * /api/hub/realtime/room-ticket`): short-lived (60 s), single use, bound to
 * the person, the document and the access the connection's grant allows
 * (`read` or `edit`). The `/yjs` gate claims it once
 * (`@synap/database/realtime-room-tickets`), and the socket then lives no
 * longer than the connection (`apiKeyId`, re-checked by the ticket sweep).
 *
 * Only a sha256 of the ticket is stored (the `mcp_connect_codes` rule): the
 * raw ticket is answered once and never persisted.
 */
import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

/** What a ticket lets its socket do (0433 `realtime_room_tickets_access_check`). */
export const ROOM_TICKET_ACCESS = ["read", "edit"] as const;
export type RoomTicketAccess = (typeof ROOM_TICKET_ACCESS)[number];

export const realtimeRoomTickets = pgTable(
  "realtime_room_tickets",
  {
    /** sha256(raw ticket), hex — the only form of the ticket that is stored. */
    ticketHash: text("ticket_hash").primaryKey(),
    /** The person the connection acts as. */
    userId: text("user_id").notNull(),
    /** The ONE document whose room the ticket opens. */
    documentId: uuid("document_id").notNull(),
    /** `read` or `edit`: the most the socket may do in that room. */
    access: text("access").$type<RoomTicketAccess>().notNull(),
    /** The connection's key that asked for it: the socket ends with it. */
    apiKeyId: uuid("api_key_id").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    /** Single-use marker. NULL = unclaimed; set atomically by the `/yjs` gate. */
    consumedAt: timestamp("consumed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    expiresIdx: index("realtime_room_tickets_expires_idx").on(table.expiresAt),
  })
);

export type RealtimeRoomTicket = typeof realtimeRoomTickets.$inferSelect;
