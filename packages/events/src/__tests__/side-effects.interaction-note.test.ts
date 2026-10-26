/**
 * The `interaction-note` reactor (CRM recall C-W2): an interaction edge's
 * creation, or an outreach touch's move to `sent` / `replied`, enqueues the
 * worker that moves "when we last spoke" forward. Everything else does not —
 * a mention, a draft, another kind's move, a role's status — and a
 * sync-origin edge still counts (a synced meeting that happened is real).
 *
 * Driven through the REAL emit loop and registry (`emitSideEffects`), with
 * only the queue mocked, so dropping the registration turns it red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn(async (..._args: unknown[]) => "job-id");

vi.mock("../boss.js", () => ({ getBoss: () => ({ send }) }));

// TOTAL mock (see side-effects.sync-origin.test.ts): side-effects.ts reads
// `createLogger` and `config.server` from core, nothing else.
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  config: { server: { vectorSearchEnabled: true } },
}));

const { emitSideEffects } = await import("../side-effects.js");

const REL = "22222222-2222-4222-8222-222222222222";
const TOUCH = "33333333-3333-4333-8333-333333333333";

function interactionJobs(): unknown[] {
  return send.mock.calls
    .filter((c) => c[0] === "interaction-note")
    .map((c) => c[1]);
}

const relationCreated = (relationType: string, origin?: "sync") =>
  emitSideEffects({
    subjectType: "relation",
    action: "create",
    subjectId: REL,
    userId: "user-1",
    workspaceId: null,
    data: { relationType, fromEntityId: "a", toEntityId: "b" },
    ...(origin ? { origin } : {}),
  });

const touchMoved = (data: Record<string, unknown>) =>
  emitSideEffects({
    subjectType: "entity",
    action: "transition",
    subjectId: TOUCH,
    userId: "user-1",
    workspaceId: "ws-1",
    data: { profileSlug: "outreach-touch", role: null, ...data },
  });

beforeEach(() => send.mockClear());

describe("interaction-note reactor", () => {
  it.each(["attended_by", "met_at", "discussed_with", "sent_to"])(
    "a %s edge enqueues its evidence read",
    async (type) => {
      await relationCreated(type);
      expect(interactionJobs()).toEqual([{ relationIds: [REL] }]);
    }
  );

  it("a synced meeting edge still counts", async () => {
    await relationCreated("attended_by", "sync");
    expect(interactionJobs()).toEqual([{ relationIds: [REL] }]);
  });

  it("a mention or any other edge does not", async () => {
    await relationCreated("mentions");
    await relationCreated("works_at");
    expect(interactionJobs()).toEqual([]);
  });

  it.each(["sent", "replied"])(
    "a touch moving to %s enqueues its sent_to read",
    async (to) => {
      await touchMoved({ to });
      expect(interactionJobs()).toEqual([{ touchIds: [TOUCH] }]);
    }
  );

  it("a draft, another kind's move or a role's status does not", async () => {
    await touchMoved({ to: "drafted" });
    await touchMoved({ to: "sent", profileSlug: "task" });
    await touchMoved({ to: "sent", role: "lead" });
    // The kind's dual-emitted update is not a second trigger.
    await emitSideEffects({
      subjectType: "entity",
      action: "update",
      subjectId: TOUCH,
      userId: "user-1",
      workspaceId: "ws-1",
      data: { profileSlug: "outreach-touch", to: "sent" },
    });
    expect(interactionJobs()).toEqual([]);
  });
});
