import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  AccessContext,
  makeRequestProvenance,
  makeWriteEnvelope,
} from "../access/context.js";

/**
 * TRIPWIRE — the AI write gate stamps attribution+provenance into ONE immutable
 * envelope, then threads THAT into the proposal door.
 *
 * Provenance (agentUserId + correlationId/session/thread/…) used to be
 * re-declared field-by-field across the stacked proposal doors
 * (checkPermissionOrPropose → createProposal → …). That hand re-threading is
 * exactly where `agentUserId` got silently dropped at a call-site spread — and a
 * dropped agentUserId turns a governed AGENT write into an ungoverned OPERATOR
 * write. This test locks in the fix on two axes:
 *
 *   1. BEHAVIOR — a boundary-minted `WriteEnvelope` (+ its `RequestProvenance`
 *      slice) is FROZEN and every provenance field survives boundary→envelope.
 *   2. SOURCE — no `createProposal(...)` call site in permission-check.ts passes
 *      loose identity/provenance keys; it MUST pass `envelope:`. A loose
 *      `agentUserId:` / `correlationId:` there is the drop-class re-appearing.
 */

describe("write-gate provenance envelope: immutable + field-preserving", () => {
  const provFields = {
    source: "intelligence",
    correlationId: "corr-1",
    requestedEventId: "evt-1",
    threadId: "thr-1",
    commandRunId: "cmd-1",
    sourceMessageId: "msg-1",
    sessionId: "sess-1",
    projectId: "proj-1",
  } as const;

  const envelope = makeWriteEnvelope(
    AccessContext.agent({ userId: "user-1", agentUserId: "agent-1" }),
    makeRequestProvenance(provFields)
  );

  it("freezes the envelope and its provenance slice", () => {
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.provenance)).toBe(true);
  });

  it("rejects mutation of the frozen envelope/provenance (strict mode throws)", () => {
    expect(() => {
      (envelope as unknown as { provenance: unknown }).provenance = {};
    }).toThrow();
    expect(() => {
      (
        envelope.provenance as unknown as { correlationId: string }
      ).correlationId = "tampered";
    }).toThrow();
    // Value is untouched after the failed mutation attempt.
    expect(envelope.provenance.correlationId).toBe("corr-1");
  });

  it("carries identity on access (attribution owner + actor=agent)", () => {
    expect(envelope.access.userId).toBe("user-1");
    expect(envelope.access.agentUserId).toBe("agent-1");
    expect(envelope.access.actor).toBe("agent");
    expect(envelope.access.isAgent).toBe(true);
  });

  it("every provenance field survives boundary→envelope unchanged", () => {
    for (const [k, v] of Object.entries(provFields)) {
      expect((envelope.provenance as Record<string, unknown>)[k]).toBe(v);
    }
  });

  it("an operator envelope carries no agent attribution (actor=operator)", () => {
    const op = makeWriteEnvelope(
      AccessContext.operator({ userId: "user-2" }),
      makeRequestProvenance({})
    );
    expect(op.access.agentUserId).toBeUndefined();
    expect(op.access.actor).toBe("operator");
    expect(op.access.isAgent).toBe(false);
  });
});

describe("tripwire: createProposal call sites pass the envelope, not loose provenance", () => {
  const permCheckPath = join(process.cwd(), "src/utils/permission-check.ts");
  const src = readFileSync(permCheckPath, "utf8");

  // Each `createProposal({ … });` CALL body. The DEFINITION is
  // `createProposal(args: {` and does NOT match `createProposal(\{`. Non-greedy
  // up to the first `});` — the reasoning template literal contains `})` (e.g.
  // `${result.role})`) but never `});`, so the terminator is unambiguous.
  const callBodies = [...src.matchAll(/createProposal\(\{([\s\S]*?)\}\);/g)].map(
    (m) => m[1]
  );

  it("finds the createProposal call sites (guards against a dead regex)", () => {
    expect(callBodies.length).toBeGreaterThanOrEqual(5);
  });

  it("every call passes `envelope:` and NO loose identity/provenance keys", () => {
    // Fields that now live on the frozen WriteEnvelope (identity on
    // `envelope.access`, provenance on `envelope.provenance`). A loose `key:` at
    // a createProposal call site is the field-by-field re-threading that dropped
    // agentUserId — forbid it so the drop-class cannot reappear here.
    const FORBIDDEN = [
      "agentUserId",
      "userId",
      "correlationId",
      "requestedEventId",
      "threadId",
      "commandRunId",
      "sourceMessageId",
      "sessionId",
      "projectId",
      "source",
    ];
    for (const body of callBodies) {
      expect(body).toMatch(/\benvelope\s*:/);
      for (const key of FORBIDDEN) {
        // Lookbehind so an allowed key that merely ENDS in a forbidden token
        // (e.g. `proposedByUserId:`) does not false-trigger — match only a
        // standalone `key:` property. (Case-sensitive: `userId` ≠ `…UserId`.)
        const re = new RegExp(`(?<![A-Za-z0-9_])${key}\\s*:`);
        expect(
          body,
          `createProposal must not pass loose \`${key}:\` — thread it via the envelope`
        ).not.toMatch(re);
      }
    }
  });
});
