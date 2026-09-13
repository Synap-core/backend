/**
 * A sync-origin emit is still INDEXED and EMBEDDED, still reaches the
 * automation matcher carrying `origin` (the matcher decides which automations
 * skip), and does NOT enqueue outbound webhook delivery or cross-thread
 * notifications.
 *
 * The reactor set is DERIVED from the live registry: every registered reactor
 * either makes the same match decision with and without `origin: "sync"`, or is
 * named in `SKIPS_SYNC_ORIGIN` and skips it. A reactor that starts skipping sync
 * writes without being named, or a named one that stops skipping, goes red.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const send = vi.fn(async (..._args: unknown[]) => "job-id");

vi.mock("../boss.js", () => ({ getBoss: () => ({ send }) }));

// TOTAL mock, deliberately: importing the real `@synap-core/core` loads and
// validates the full pod config (DATABASE_URL …) at module load. side-effects.ts
// reads exactly two names from it — `createLogger` and `config.server` — so
// both are supplied; a new core import in side-effects.ts fails loudly here.
vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  config: { server: { vectorSearchEnabled: true } },
}));

const { emitSideEffects, getReactors, SKIPS_SYNC_ORIGIN } =
  await import("../side-effects.js");

const BASE = {
  subjectType: "entity",
  action: "create",
  subjectId: "11111111-1111-4111-8111-111111111111",
  userId: "user-1",
  workspaceId: "ws-1",
  data: { profileSlug: "person" },
} as const;

function queuesSent(): string[] {
  return send.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => send.mockClear());

describe("emitSideEffects — origin: 'sync'", () => {
  it("still enqueues search-index AND entity-embedding for a sync write", async () => {
    await emitSideEffects({ ...BASE, origin: "sync" });
    expect(queuesSent()).toContain("search-index");
    expect(queuesSent()).toContain("entity-embedding");
  });

  it("forwards origin to the automation matcher job (top-level, not in data)", async () => {
    await emitSideEffects({ ...BASE, origin: "sync" });
    const matchCall = send.mock.calls.find(
      (c) => c[0] === "automation-trigger-match"
    );
    expect(matchCall).toBeDefined();
    const job = matchCall![1] as Record<string, unknown>;
    expect(job.origin).toBe("sync");
    expect((job.data as Record<string, unknown>).origin).toBeUndefined();
  });

  it("an ordinary write carries no origin to the matcher", async () => {
    await emitSideEffects({ ...BASE });
    const job = send.mock.calls.find(
      (c) => c[0] === "automation-trigger-match"
    )![1] as Record<string, unknown>;
    expect("origin" in job).toBe(false);
  });

  it("a sync write enqueues no outbound webhook delivery or cross-thread notify; an ordinary update enqueues both", async () => {
    await emitSideEffects({ ...BASE, action: "update", origin: "sync" });
    expect(queuesSent()).not.toContain("webhook-delivery");
    expect(queuesSent()).not.toContain("cross-thread-notify");
    expect(queuesSent()).toContain("search-index");

    send.mockClear();
    await emitSideEffects({ ...BASE, action: "update" });
    expect(queuesSent()).toContain("webhook-delivery");
    expect(queuesSent()).toContain("cross-thread-notify");
  });

  it("only the reactors named in SKIPS_SYNC_ORIGIN change their match decision because of origin", () => {
    const reactors = getReactors();
    const ids = reactors.map((r) => r.id);
    // Non-vacuity: the registry this scan walks is the real one, and every
    // named skipper is registered.
    expect(reactors.length).toBeGreaterThanOrEqual(7);
    expect(ids).toContain("search-index");
    for (const id of SKIPS_SYNC_ORIGIN) expect(ids).toContain(id);

    const skippers = new Set<string>(SKIPS_SYNC_ORIGIN);
    for (const action of ["create", "update"]) {
      const plain = { ...BASE, action };
      for (const r of reactors) {
        const withSync = r.match ? r.match({ ...plain, origin: "sync" }) : true;
        const without = r.match ? r.match(plain) : true;
        if (skippers.has(r.id)) {
          expect(withSync, `reactor ${r.id} must skip sync writes`).toBe(false);
        } else {
          expect(withSync, `reactor ${r.id} must not skip sync writes`).toBe(
            without
          );
        }
      }
    }
  });
});

describe("connection-sync-approval reactor", () => {
  it("enqueues the approval worker for an approved proposal (keyed per proposal)", async () => {
    await emitSideEffects({
      subjectType: "proposal",
      action: "approved",
      subjectId: "prop-1",
      userId: "user-1",
      workspaceId: "ws-1",
      data: { proposalStatus: "approved" },
    });
    const call = send.mock.calls.find(
      (c) => c[0] === "connection-sync-approval"
    );
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ proposalId: "prop-1", userId: "user-1" });
    expect(call![2]).toMatchObject({
      singletonKey: "connection-sync-approval:prop-1",
    });
  });

  it("does not enqueue for a rejected proposal", async () => {
    await emitSideEffects({
      subjectType: "proposal",
      action: "rejected",
      subjectId: "prop-1",
      userId: "user-1",
      workspaceId: "ws-1",
    });
    expect(queuesSent()).not.toContain("connection-sync-approval");
  });
});

describe("enqueueConnectionSyncApproval (the one enqueue, shared by reactor + pod-wide approval path)", () => {
  it("sends the same job shape and per-proposal singletonKey the reactor uses", async () => {
    const { enqueueConnectionSyncApproval } =
      await import("../side-effects.js");
    const own = vi.fn(async (..._a: unknown[]) => "id");
    await enqueueConnectionSyncApproval(
      { proposalId: "prop-9", userId: "u-9" },
      { send: own } as never
    );
    expect(own).toHaveBeenCalledTimes(1);
    expect(own.mock.calls[0]).toEqual([
      "connection-sync-approval",
      { proposalId: "prop-9", userId: "u-9" },
      { singletonKey: "connection-sync-approval:prop-9" },
    ]);

    // Parity: the reactor's enqueue for the same proposal is byte-identical, so a
    // proposal reached by both doors collapses onto one singleton job.
    send.mockClear();
    await emitSideEffects({
      subjectType: "proposal",
      action: "approved",
      subjectId: "prop-9",
      userId: "u-9",
      workspaceId: "ws-1",
    });
    const reactorCall = send.mock.calls.find(
      (c) => c[0] === "connection-sync-approval"
    );
    expect(reactorCall).toEqual(own.mock.calls[0]);
  });
});
