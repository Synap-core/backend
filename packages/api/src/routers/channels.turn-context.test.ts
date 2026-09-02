import { describe, expect, it } from "vitest";
import {
  channelSendMessageInputSchema,
  redactTurnContext,
  TurnContextSchema,
  usesInternalSessionBoundary,
} from "./channels.js";
import { ChannelType } from "@synap/database";

describe("channels.sendMessage turnContext", () => {
  it("accepts a compact flat context and redacts sensitive entries", () => {
    const context = TurnContextSchema.parse({
      entries: [
        { key: "selectionIds", value: ["entity-1", "entity-2"] },
        { key: "viewMode", value: "compact" },
        { key: "apiToken", value: "never-persist-this" },
      ],
    });

    expect(redactTurnContext(context)).toEqual({
      entries: [
        { key: "selectionIds", value: ["entity-1", "entity-2"] },
        { key: "viewMode", value: "compact" },
        { key: "apiToken", value: "[redacted]" },
      ],
    });
  });

  it("rejects unknown fields, nested values, and oversized entry lists", () => {
    expect(() =>
      TurnContextSchema.parse({
        entries: [{ key: "viewMode", value: "compact", extra: true }],
      })
    ).toThrow();
    expect(() =>
      TurnContextSchema.parse({
        entries: [{ key: "selection", value: { ids: ["entity-1"] } }],
      })
    ).toThrow();
    expect(() =>
      TurnContextSchema.parse({
        entries: Array.from({ length: 21 }, (_, index) => ({
          key: `item${index}`,
          value: index,
        })),
      })
    ).toThrow();
    expect(() =>
      TurnContextSchema.parse({
        entries: [{ key: "title", value: "x".repeat(401) }],
      })
    ).toThrow();
    expect(() =>
      TurnContextSchema.parse({
        entries: Array.from({ length: 20 }, (_, index) => ({
          key: `longEntry${index}`,
          value: "x".repeat(400),
        })),
      })
    ).toThrow();
  });

  it("accepts entries-only, session-only, and both — and rejects an empty object", () => {
    const session = {
      version: 1 as const,
      id: "session-1",
      goal: "Ship the turn-context session sibling",
      stage: "build",
      progress: 40,
      depth: 1,
      chain: [{ id: "session-0", goal: "Parent goal" }],
      suspendedIntent: "Finish the audit first",
    };

    // The pre-session payload must keep working verbatim.
    expect(
      TurnContextSchema.safeParse({
        entries: [{ key: "viewMode", value: "compact" }],
      }).success
    ).toBe(true);
    expect(TurnContextSchema.safeParse({ session }).success).toBe(true);
    expect(
      TurnContextSchema.safeParse({
        entries: [{ key: "viewMode", value: "compact" }],
        session,
      }).success
    ).toBe(true);

    // `entries` going optional must not make `{}` newly acceptable.
    expect(TurnContextSchema.safeParse({}).success).toBe(false);
    // Nor an explicitly empty entries array.
    expect(TurnContextSchema.safeParse({ entries: [] }).success).toBe(false);
  });

  it("pins the session sibling's bounds to the Intelligence Service twin", () => {
    // TWIN: synap-intelligence-service/apps/intelligence-hub/src/routes/chat-stream.ts
    // (`TurnContextSchema` / `TurnContextSessionSchema`). If this test fails,
    // the pod and the IS disagree about the wire contract — fix BOTH files,
    // never just this one. A field the pod rejects never reaches the agent; a
    // field the IS rejects 400s a turn the pod already persisted.
    const base = {
      version: 1 as const,
      id: "session-1",
      goal: "Ship it",
      depth: 0,
      chain: [],
    };

    const ok = (patch: Record<string, unknown>) =>
      TurnContextSchema.safeParse({ session: { ...base, ...patch } }).success;

    // Field list is closed — `.strict()` on both sides.
    expect(ok({ unknownField: "x" })).toBe(false);
    // version is a literal 1, not "any number".
    expect(ok({ version: 2 })).toBe(false);
    // Required fields.
    expect(
      TurnContextSchema.safeParse({ session: { ...base, id: undefined } })
        .success
    ).toBe(false);
    expect(
      TurnContextSchema.safeParse({ session: { ...base, goal: undefined } })
        .success
    ).toBe(false);
    expect(
      TurnContextSchema.safeParse({ session: { ...base, depth: undefined } })
        .success
    ).toBe(false);
    expect(
      TurnContextSchema.safeParse({ session: { ...base, chain: undefined } })
        .success
    ).toBe(false);
    // Optional fields.
    expect(ok({ stage: "build", progress: 0, suspendedIntent: "later" })).toBe(
      true
    );

    // Bounds: id/stage 64, goal/suspendedIntent 400, depth int 0..8, chain <= 8.
    expect(ok({ id: "x".repeat(64) })).toBe(true);
    expect(ok({ id: "x".repeat(65) })).toBe(false);
    expect(ok({ stage: "x".repeat(65) })).toBe(false);
    expect(ok({ goal: "x".repeat(400) })).toBe(true);
    expect(ok({ goal: "x".repeat(401) })).toBe(false);
    expect(ok({ suspendedIntent: "x".repeat(401) })).toBe(false);
    expect(ok({ progress: -1 })).toBe(false);
    expect(ok({ progress: 101 })).toBe(false);
    expect(ok({ depth: 1.5 })).toBe(false);
    expect(ok({ depth: -1 })).toBe(false);
    expect(ok({ depth: 8 })).toBe(true);
    expect(ok({ depth: 9 })).toBe(false);
    expect(
      ok({
        chain: Array.from({ length: 8 }, (_, i) => ({
          id: `s${i}`,
          goal: "g",
        })),
      })
    ).toBe(true);
    expect(
      ok({
        chain: Array.from({ length: 9 }, (_, i) => ({
          id: `s${i}`,
          goal: "g",
        })),
      })
    ).toBe(false);
    expect(ok({ chain: [{ id: "s0", goal: "g", extra: true }] })).toBe(false);

    // The serialized ceiling covers the session too.
    expect(
      ok({
        chain: Array.from({ length: 8 }, (_, i) => ({
          id: `s${i}`,
          goal: "g".repeat(400),
        })),
        goal: "g".repeat(400),
        suspendedIntent: "s".repeat(400),
      })
    ).toBe(true);
  });

  it("redacts entries without dropping the session sibling", () => {
    const session = {
      version: 1 as const,
      id: "session-1",
      goal: "Keep the sibling",
      depth: 0,
      chain: [],
    };
    const context = TurnContextSchema.parse({
      entries: [
        { key: "viewMode", value: "compact" },
        { key: "apiToken", value: "never-persist-this" },
      ],
      session,
    });

    // Regression: the redactor used to rebuild `{ entries }`, silently
    // stripping `session` on the way to the Intelligence Service.
    expect(redactTurnContext(context)).toEqual({
      entries: [
        { key: "viewMode", value: "compact" },
        { key: "apiToken", value: "[redacted]" },
      ],
      session,
    });

    expect(redactTurnContext(TurnContextSchema.parse({ session }))).toEqual({
      session,
    });
  });

  it("gives Personal turns an internal memory-session boundary", () => {
    expect(usesInternalSessionBoundary(ChannelType.PERSONAL)).toBe(true);
    expect(usesInternalSessionBoundary(ChannelType.FEED)).toBe(false);
  });

  it("accepts only a UUID as the canonical project lens", () => {
    expect(
      channelSendMessageInputSchema.safeParse({
        content: "Use the active project",
        projectId: "79f58d96-dca2-4f96-ad20-9a3ae619fdf3",
      }).success
    ).toBe(true);
    expect(
      channelSendMessageInputSchema.safeParse({
        content: "Use the active project",
        projectId: "not-a-project-id",
      }).success
    ).toBe(false);
  });
});
