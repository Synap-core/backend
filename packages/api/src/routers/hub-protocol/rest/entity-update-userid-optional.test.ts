/**
 * PATCH /entities/:entityId must accept a body with NO `userId`.
 *
 * The defect: `UpdateEntityRequestSchema` declared `userId: z.string()`
 * (required) while the handler has always written
 * `const userId = body.userId ?? authUserId` and gated it with
 * `mayActAsUser(c, body.userId)`, which returns true for an absent value
 * ("acting as self"). The schema runs BEFORE the handler, so that `??`
 * fallback was unreachable dead code and every caller that did not send a
 * userId got `400 userId: Invalid input: expected string, received undefined`.
 *
 * `HubRestClient.updateEntity` never sends one — so the official client, and
 * every tool built on it, could not update an entity at all. Measured live
 * 2026-09-22 against the deployed pod: the REST PATCH 400s while the MCP door
 * (tRPC) updates the same entity successfully. `CreateEntityRequestSchema`
 * was already `.optional()`, which is exactly why agents could CREATE but not
 * UPDATE.
 *
 * WHAT THIS DOES NOT COVER: the other hub codecs that still declare
 * `userId: z.string()` (relation, document, profile, search, skill, auth).
 * Those were NOT changed — their handlers were not audited here, and a
 * required userId is legitimate where the handler has no self-fallback. The
 * rule to apply when auditing them: a schema may require `userId` only if its
 * handler does NOT write `body.userId ?? authUserId`.
 */
import { describe, it, expect } from "vitest";
import {
  UpdateEntityRequestSchema,
  CreateEntityRequestSchema,
} from "./_codecs/entity.js";

describe("UpdateEntityRequestSchema", () => {
  it("accepts a body with no userId (the acting user defaults to the caller)", () => {
    const parsed = UpdateEntityRequestSchema.safeParse({
      metadata: { "wedge-stage": "wedge_c" },
    });
    expect(parsed.success).toBe(true);
  });

  it("still accepts an explicit userId (on-behalf-of, gated by mayActAsUser)", () => {
    const parsed = UpdateEntityRequestSchema.safeParse({
      userId: "user-1",
      title: "x",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-string userId", () => {
    const parsed = UpdateEntityRequestSchema.safeParse({ userId: 42 });
    expect(parsed.success).toBe(false);
  });

  it("matches CREATE, which was already optional — the two doors agree now", () => {
    expect(
      CreateEntityRequestSchema.safeParse({
        profileSlug: "note",
        title: "x",
      }).success
    ).toBe(true);
  });
});
