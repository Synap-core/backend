/**
 * Tests for the realtime event schema registry. Pure unit tests — no DB,
 * no bridge. We exercise schema accept/reject behavior and the
 * `getSchemaForEvent` lookup contract.
 */

import { describe, it, expect } from "vitest";
import { EventSchemas, getSchemaForEvent } from "../realtime-schemas.js";

const VALID_PAYLOADS = {
  "openclaw:message:received": {
    channelId: "ch_1",
    messageId: "msg_1",
    platform: "telegram" as const,
    excerpt: "hello",
    receivedAt: "2026-05-05T10:00:00Z",
  },
  "synap:reply:routed": {
    channelId: "ch_1",
    messageId: "msg_1",
    targetPlatform: "telegram",
    excerpt: "ack",
    routedAt: "2026-05-05T10:00:01Z",
  },
  "hermes:task:queued": {
    taskId: "tsk_1",
    kind: "lead.enrich",
    source: "agent:orchestrator",
    queuedAt: "2026-05-05T10:00:00Z",
  },
  "hermes:task:started": {
    taskId: "tsk_1",
    kind: "lead.enrich",
    startedAt: "2026-05-05T10:00:01Z",
  },
  "hermes:task:completed": {
    taskId: "tsk_1",
    durationMs: 1234,
    completedAt: "2026-05-05T10:00:05Z",
  },
  "hermes:task:failed": {
    taskId: "tsk_1",
    error: "rate limited",
    failedAt: "2026-05-05T10:00:05Z",
  },
} as const;

describe("EventSchemas — {actor}:{entity}:{action} payloads", () => {
  it("accepts valid payloads for each new event", () => {
    for (const [event, payload] of Object.entries(VALID_PAYLOADS)) {
      const schema = EventSchemas[event as keyof typeof EventSchemas];
      expect(schema, `missing schema for ${event}`).toBeDefined();
      const result = schema!.safeParse(payload);
      expect(result.success, `failed for ${event}`).toBe(true);
    }
  });

  it("rejects openclaw:message:received with unknown platform", () => {
    const result = EventSchemas["openclaw:message:received"]!.safeParse({
      ...VALID_PAYLOADS["openclaw:message:received"],
      platform: "carrier-pigeon",
    });
    expect(result.success).toBe(false);
  });

  it("rejects openclaw:message:received missing required field", () => {
    const result = EventSchemas["openclaw:message:received"]!.safeParse({
      channelId: "ch_1",
      // messageId omitted
      platform: "telegram",
      excerpt: "",
      receivedAt: "2026-05-05T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects synap:reply:routed missing targetPlatform", () => {
    const result = EventSchemas["synap:reply:routed"]!.safeParse({
      channelId: "ch_1",
      messageId: "msg_1",
      excerpt: "",
      routedAt: "2026-05-05T10:00:01Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects hermes:task:queued with empty taskId", () => {
    const result = EventSchemas["hermes:task:queued"]!.safeParse({
      taskId: "",
      kind: "lead.enrich",
      source: "agent:orchestrator",
      queuedAt: "2026-05-05T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects hermes:task:started with non-string startedAt", () => {
    const result = EventSchemas["hermes:task:started"]!.safeParse({
      taskId: "tsk_1",
      kind: "lead.enrich",
      startedAt: 1714900000,
    });
    expect(result.success).toBe(false);
  });

  it("rejects hermes:task:completed with negative durationMs", () => {
    const result = EventSchemas["hermes:task:completed"]!.safeParse({
      taskId: "tsk_1",
      durationMs: -1,
      completedAt: "2026-05-05T10:00:05Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects hermes:task:failed with empty error", () => {
    const result = EventSchemas["hermes:task:failed"]!.safeParse({
      taskId: "tsk_1",
      error: "",
      failedAt: "2026-05-05T10:00:05Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("getSchemaForEvent", () => {
  it("returns the schema for a known event", () => {
    const schema = getSchemaForEvent("openclaw:message:received");
    expect(schema).toBeDefined();
    const result = schema!.safeParse(
      VALID_PAYLOADS["openclaw:message:received"]
    );
    expect(result.success).toBe(true);
  });

  it("returns undefined for an unknown event", () => {
    expect(getSchemaForEvent("unknown:event:foo")).toBeUndefined();
  });

  it("returns undefined for legacy events without locked schemas", () => {
    // notification:new is intentionally not schema-locked (still in flux)
    expect(getSchemaForEvent("notification:new")).toBeUndefined();
  });
});
