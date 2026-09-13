/**
 * `resolveImportSession` must forward the acting AGENT to `ensureIntakeSession`
 * so a minted import room is `origin:"agent"` for an agent-key caller —
 * `origin:"human"` for every caller was the bug (the REST `/import/analyze`
 * and `/import/enqueue-corpus` handlers never threaded `agentUserId` into
 * `trpcCtx`, and `resolveImportSession` itself never read it back out).
 *
 * `ensureIntakeSession` is mocked here — its own origin derivation
 * (`input.agentUserId ? "agent" : "human"`) is pinned on real Postgres in
 * `intake-run.pglite.test.ts` ("a person's capture room is origin human; an
 * agent's is origin agent"). This test covers the SEAM above it: does
 * `resolveImportSession` even pass `agentUserId` through.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { ensureIntakeSessionMock } = vi.hoisted(() => ({
  ensureIntakeSessionMock: vi.fn(),
}));

vi.mock("../../intake/ensure-intake-session.js", () => ({
  ensureIntakeSession: ensureIntakeSessionMock,
}));

vi.mock("../../../routers/hub-protocol/_middleware/session.js", () => ({
  resolveVerifiedSessionId: vi.fn().mockResolvedValue(undefined),
}));

import { resolveImportSession } from "../session.js";
import type { ImportAnalyzeInput } from "../../import-orchestrator.js";
import type { OrchestratorContext } from "../types.js";

const baseInput: ImportAnalyzeInput = {
  source: "markdown",
  items: [{ text: "hello" }],
} as unknown as ImportAnalyzeInput;

function ctxWith(trpcCtx: Record<string, unknown>): OrchestratorContext {
  return {
    userId: "user-1",
    workspaceId: "ws-1",
    trpcCtx,
  } as OrchestratorContext;
}

describe("resolveImportSession forwards the acting agent", () => {
  beforeEach(() => {
    ensureIntakeSessionMock.mockReset();
    ensureIntakeSessionMock.mockResolvedValue({
      status: "minted",
      sessionId: "sess-1",
      reused: false,
    });
  });

  it("an agent-key caller mints an agent-attributed room", async () => {
    await resolveImportSession(ctxWith({ agentUserId: "agent-9" }), baseInput);
    expect(ensureIntakeSessionMock).toHaveBeenCalledTimes(1);
    expect(ensureIntakeSessionMock.mock.calls[0]![0]).toMatchObject({
      agentUserId: "agent-9",
    });
  });

  it("a non-string or empty agentUserId on the untyped trpcCtx is NOT an agent", async () => {
    for (const bogus of [123, { id: "agent-9" }, ""]) {
      ensureIntakeSessionMock.mockClear();
      await resolveImportSession(ctxWith({ agentUserId: bogus }), baseInput);
      expect(ensureIntakeSessionMock.mock.calls[0]![0]).toMatchObject({
        agentUserId: null,
      });
    }
  });

  it("a human caller (no agentUserId on trpcCtx) mints a human-attributed room", async () => {
    await resolveImportSession(ctxWith({}), baseInput);
    expect(ensureIntakeSessionMock.mock.calls[0]![0]).toMatchObject({
      agentUserId: null,
    });
  });
});
