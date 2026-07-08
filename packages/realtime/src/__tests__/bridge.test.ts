/**
 * Bridge payload validation tests
 *
 * Exercises `validateEmitPayload` — the helper that powers the bridge's
 * `/bridge/emit` payload check. We test the contract the bridge guarantees:
 *
 *   1. Legacy events without a schema fall through (backwards-compat).
 *   2. New events with valid payloads are accepted.
 *   3. New events with malformed payloads are rejected with structured issues.
 *
 * The HTTP layer is glue around this helper; testing the helper directly
 * keeps these tests fast and hermetic. Full-stack bridge tests live in
 * `integration.test.ts` (excluded from the unit run).
 */

import { describe, it, expect } from "vitest";
import { validateEmitPayload } from "../bridge.js";

describe("validateEmitPayload", () => {
  it("accepts a legacy event with no registered schema (pass-through)", () => {
    // notification:new is legacy with no schema — must still flow through.
    const result = validateEmitPayload("notification:new", {
      anything: "goes",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a completely unknown event name (pass-through)", () => {
    const result = validateEmitPayload("custom:thing:made-up", { foo: 1 });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid {actor}:{entity}:{action} payload", () => {
    const result = validateEmitPayload("synap:reply:routed", {
      channelId: "ch_1",
      messageId: "msg_1",
      targetPlatform: "telegram",
      excerpt: "on it",
      routedAt: "2026-05-05T10:00:00Z",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed {actor}:{entity}:{action} payload", () => {
    const result = validateEmitPayload("synap:reply:routed", {
      channelId: "ch_1",
      // missing messageId, targetPlatform, excerpt, routedAt
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.issues)).toBe(true);
      expect((result.issues as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("rejects openclaw:message:received with an unsupported platform", () => {
    const result = validateEmitPayload("openclaw:message:received", {
      channelId: "ch_1",
      messageId: "msg_1",
      platform: "carrier-pigeon",
      excerpt: "",
      receivedAt: "2026-05-05T10:00:00Z",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects entity:created with non-string entityId (legacy lockdown)", () => {
    const result = validateEmitPayload("entity:created", {
      entityId: 123,
      workspaceId: "ws_1",
      type: "note",
      title: "x",
      createdBy: "u",
      createdAt: "2026-05-05T10:00:00Z",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts entity:created with all required fields plus extras", () => {
    const result = validateEmitPayload("entity:created", {
      entityId: "ent_1",
      workspaceId: "ws_1",
      type: "note",
      title: "x",
      createdBy: "u",
      createdAt: "2026-05-05T10:00:00Z",
      // optimistic-update extras allowed
      entity: { id: "ent_1", title: "x" },
    });
    expect(result.ok).toBe(true);
  });
});
