/**
 * The `roomPost` metadata key is spelled twice ON PURPOSE: `room-post-kind.ts`
 * is pure (the MCP tool schema and the Hub codec import it, so it cannot pull
 * the database client in), and `@synap/database` open-room-question needs it
 * for the reapers, which cannot import api. This pins the two equal — a
 * renamed key on one side would make the reapers read every question as
 * absent and close sessions under open questions.
 */
import { describe, it, expect } from "vitest";
import { ROOM_POST_META_KEY } from "./room-post-kind.js";
import { ROOM_POST_META_KEY as DB_ROOM_POST_META_KEY } from "@synap/database";

describe("room post metadata key", () => {
  it("is the same key in the pure kind module and the shared open-question rule", () => {
    expect(DB_ROOM_POST_META_KEY).toBe(ROOM_POST_META_KEY);
  });
});
