/**
 * Seam test — a DIRECT capability run (the `decision === "run"` branch, no
 * proposal) persists its SESSION and its IDEMPOTENCY KEY on the run record.
 *
 * THE GAP (live-dogfooded 2026-09-12, run `3ecbf109…`): the tRPC / Hub / MCP
 * doors all forward `sessionId` + `idempotencyKey` (contract
 * `contracts/capability-execute.ts`), and the PROPOSED branch persists both —
 * `proposals.session_id` (column) and `data.idempotencyKey`. The DIRECT branch
 * persisted NEITHER: `recordDirectCapabilityRun` emitted the `capability_run`
 * ai_decision event with no session and no key, so a direct run was
 * unattributable to the session that caused it and its at-most-once key was
 * invisible to every reader.
 *
 * The run record for a direct run IS that event (there is no unified `runs`
 * table — see services/runs/types.ts). So the assertions are on the object
 * handed to `emitAiDecision`: the `sessionId` COLUMN (events.session_id, 0241 —
 * what the index keys on) and `data.idempotencyKey`.
 *
 * Both direct sub-paths are covered, because they are two different writers'
 * call sites of the same recorder:
 *   - UNGUARDED  — local builtin / read verb (no receipt).
 *   - RECEIPTED  — external-send verb through `runDirectWriteVerbOnce`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const SESSION = "5f3a1c88-3333-4bbb-8ccc-444444444444";
const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = "explicit-key-0001";

/** Every `emitAiDecision` call, in order. */
const emitted: any[] = [];
/** In-memory `capability_run_receipts`. */
let receipts: any[] = [];

let SKILL_ROW: any = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "entity.create",
  approved: true,
  userId: "user-1",
  kind: "builtin",
  providerSpec: null,
};

// PARTIAL mock — a whole-module factory would null every sibling export this
// graph relies on. Only `db` (skill lookup + the receipt table) and the two
// best-effort side-effect doors are replaced.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const receiptTable = actual.capabilityRunReceipts;
  return {
    ...actual,
    getWorkspaceMembership: async () => ({ role: "owner" }),
    knowledgeRepository: { saveFact: async () => undefined },
    db: {
      select: (_cols?: unknown) => ({
        from: (table: unknown) => ({
          where: () => ({
            orderBy: () => ({
              limit: async () =>
                table === receiptTable
                  ? receipts.length
                    ? [receipts[receipts.length - 1]]
                    : []
                  : [SKILL_ROW],
            }),
          }),
        }),
      }),
      insert: () => ({
        values: (v: any) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              // CAS: the unique index is (idempotency_key, dedup_bucket).
              const clash = receipts.some(
                (r) =>
                  r.idempotencyKey === v.idempotencyKey &&
                  (r.dedupBucket ?? 1) === (v.dedupBucket ?? 1)
              );
              if (clash) return [];
              const row = { ...v, id: `receipt-${receipts.length + 1}` };
              receipts.push(row);
              return [{ id: row.id }];
            },
          }),
        }),
      }),
      update: () => ({
        set: (patch: any) => ({
          where: async () => {
            const last = receipts[receipts.length - 1];
            if (last) Object.assign(last, patch);
          },
        }),
      }),
      delete: () => ({
        where: async () => {
          receipts.pop();
        },
      }),
    },
  };
});

vi.mock("./gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({ decision: "run" }),
  CAPABILITY_RUN_PROPOSAL: {
    targetType: "capability",
    proposalType: "capability.run",
  },
}));

vi.mock("../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: async (opts: any) => {
    emitted.push(opts);
  },
}));

/** The external connector — asserted to fire exactly ONCE across a retry. */
const connector = vi.fn(async () => ({ sent: true }));
vi.mock("./execute-provider-verb.js", () => ({
  executeProviderVerb: (...args: unknown[]) => connector(...(args as [])),
}));

const { executeCapability } = await import("./execute-capability.js");
const { BUILTIN_VERBS } = await import("./builtin-verbs.js");

const BASE = {
  verbId: "entity.create",
  parameters: { name: "Acme" },
  workspaceId: WS,
  userId: "user-1",
};

const DECLARATIVE_SKILL = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "gmail_send",
  approved: true,
  userId: "user-1",
  kind: "declarative",
  providerSpec: { method: "POST" },
};

describe("executeCapability — DIRECT run provenance (session + idempotency key)", () => {
  beforeEach(() => {
    emitted.length = 0;
    receipts = [];
    connector.mockClear();
    SKILL_ROW = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "entity.create",
      approved: true,
      userId: "user-1",
      kind: "builtin",
      providerSpec: null,
    };
    BUILTIN_VERBS["entity.create"] = (async () => ({ ok: true })) as never;
  });

  it("UNGUARDED path: stamps the caller's sessionId and idempotencyKey on the run record", async () => {
    const out = await executeCapability({
      ...BASE,
      sessionId: SESSION,
      idempotencyKey: KEY,
    });
    expect(out.kind).toBe("run");
    const run = emitted.find((e) => e.data?.kind === "capability_run");
    expect(run).toBeDefined();
    // The COLUMN (events.session_id, 0241) — that is what the index keys on.
    expect(run.sessionId).toBe(SESSION);
    expect(run.data.idempotencyKey).toBe(KEY);
  });

  it("UNGUARDED path: writes no session/key when the caller passed none (correct for non-session activity)", async () => {
    await executeCapability(BASE);
    const run = emitted.find((e) => e.data?.kind === "capability_run");
    expect(run.sessionId ?? null).toBeNull();
    expect(run.data.idempotencyKey).toBeUndefined();
  });

  it("RECEIPTED path: an external-send verb stamps both too", async () => {
    SKILL_ROW = DECLARATIVE_SKILL;
    const out = await executeCapability({
      ...BASE,
      verbId: "gmail_send",
      sessionId: SESSION,
      idempotencyKey: KEY,
    });
    expect(out.kind).toBe("run");
    const run = emitted.find((e) => e.data?.kind === "capability_run");
    expect(run.sessionId).toBe(SESSION);
    expect(run.data.idempotencyKey).toBe(KEY);
  });

  it("RECEIPTED path: a retry with the SAME explicit key replays the receipt and sends once", async () => {
    SKILL_ROW = DECLARATIVE_SKILL;
    const first = await executeCapability({
      ...BASE,
      verbId: "gmail_send",
      sessionId: SESSION,
      idempotencyKey: KEY,
    });
    const second = await executeCapability({
      ...BASE,
      verbId: "gmail_send",
      sessionId: SESSION,
      idempotencyKey: KEY,
    });
    expect((first as any).ackState).toBe("applied");
    expect((second as any).ackState).toBe("duplicate-ignored");
    // The whole point: the irreversible external effect fired exactly once.
    expect(connector).toHaveBeenCalledTimes(1);
    // The replay lands on the SAME run handle as the first call.
    expect((second as any).correlationId).toBe((first as any).correlationId);
  });

  it("a LOCAL write with an EXPLICIT key is at-most-once too (the key is a caller declaration)", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    BUILTIN_VERBS["entity.create"] = handler as never;
    const first = await executeCapability({
      ...BASE,
      sessionId: SESSION,
      idempotencyKey: KEY,
    });
    const second = await executeCapability({
      ...BASE,
      sessionId: SESSION,
      idempotencyKey: KEY,
    });
    expect((first as any).ackState).toBe("applied");
    expect((second as any).ackState).toBe("duplicate-ignored");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a LOCAL write with NO explicit key still runs unguarded (two identical writes are two writes)", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    BUILTIN_VERBS["entity.create"] = handler as never;
    await executeCapability(BASE);
    await executeCapability(BASE);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(receipts).toHaveLength(0);
  });
});
