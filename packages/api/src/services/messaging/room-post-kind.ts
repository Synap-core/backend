/**
 * What an agent's room post IS — the `kind` param on MCP `synap_post_message`
 * and Hub REST `POST /threads/:id/messages`. Pure (no I/O) so the tool schema
 * and the Hub codec can derive their enums from it.
 *
 * `question` — the person is needed; in a session room it pushes once per
 * session window (`session.needs_you`). `update` (default) — progress and
 * results; in-app only, never a push (`session.room_update`).
 */
export const ROOM_POST_KINDS = ["question", "update"] as const;
export type RoomPostKind = (typeof ROOM_POST_KINDS)[number];
