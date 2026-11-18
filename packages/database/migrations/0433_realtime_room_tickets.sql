-- 0433 — realtime room tickets: a pod app opens a live Yjs room (board lane
-- wb-room; founder decisions of 18 Nov 2026, session 52ce3ee9: "Apps open
-- live rooms: Yes").
--
-- A pod app holds its person's connection token (an `app_person` api key,
-- 0339) on its own server. The `/yjs` gate takes only a Kratos session or a
-- Synap app's device token, so a pod app could not open a room at all. The
-- app now trades its token for a TICKET (`POST /api/hub/realtime/room-ticket`)
-- that its browser hands to the `/yjs` handshake:
--   * short-lived: `expires_at` is 60 s after it is made;
--   * single use: the gate claims it once (`consumed_at` NULL → now, in one
--     UPDATE), so a replayed ticket opens nothing;
--   * bound to the person (`user_id`), ONE document (`document_id`) and the
--     most the socket may do there (`access`: read or edit), decided from the
--     connection's grant when the ticket was made;
--   * the socket then lives no longer than the connection: `api_key_id` is
--     re-checked by the realtime ticket sweep (a rotated key of the same
--     connection keeps it; a revoked connection closes it).
-- Only a sha256 of the ticket is stored (the 0206 mcp_connect_codes rule).
-- Expired rows are deleted when the next ticket is made.

CREATE TABLE IF NOT EXISTS "realtime_room_tickets" (
  "ticket_hash"  text        PRIMARY KEY,
  "user_id"      text        NOT NULL,
  "document_id"  uuid        NOT NULL,
  "access"       text        NOT NULL,
  "api_key_id"   uuid        NOT NULL,
  "expires_at"   timestamptz NOT NULL,
  "consumed_at"  timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "realtime_room_tickets_access_check"
    CHECK ("access" IN ('read', 'edit'))
);

-- The clean-up's read: rows past their expiry.
CREATE INDEX IF NOT EXISTS "realtime_room_tickets_expires_idx"
  ON "realtime_room_tickets" ("expires_at");
