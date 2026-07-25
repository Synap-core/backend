/**
 * `proposals.batchApprove` must route through the proposal-execution registry.
 *
 * THE BUG (live, user-facing): `batchApprove` inlined ONLY the generic
 * `.validated`-emit path, flipped the row to APPROVED and emitted
 * `emitProposalReviewed` — it never resolved or ran an executor. So "Approve
 * all" (ProposalsCell / ProposalReviewBoard, rendered in the browser's
 * Sessions/Workflows ground cell) silently did NOTHING for every proposal type
 * whose subject the materializer worker has no case for — automation/execute,
 * document/create, channel/*, property_def/create, focus_session/create,
 * project/create|archive, skill/create, automation/create, playbook/*,
 * messaging.external.send, capability.run|install|enable, provider.action —
 * and ran the WRONG (generic) path for the ~13 subjects it does handle.
 *
 * THE FIX: both approve doors now call ONE function, `applyProposalApproval`
 * (proposals.ts), whose tail is `dispatchProposalApproval` (execution-registry
 * .ts) — resolve → execute → APPROVAL_FAILED-on-throw → re-throw. A batch
 * approve is exactly N single approves.
 *
 * Same no-DB style as execute-executors.test.ts / workspace-create-executor
 * .test.ts (the api suite needs live Postgres for anything touching the db):
 * the runtime dispatch is proven EXECUTABLY against the real
 * `dispatchProposalApproval`, and the wiring of the two callers is proven
 * structurally against the source.
 *
 * Coverage:
 *   (a) the regression — a key with NO materializer case (automation/execute)
 *       really does invoke its SPECIFIC executor through the shared door
 *   (b) both doors call the one function; batch no longer inlines its own
 *       status flip / audit emit
 *   (c) partial failure — item 3 of 10 throwing sinks neither 1-2 nor 4-10
 *   (d) per-item failure is VISIBLE (APPROVAL_FAILED + rejectionReason + the
 *       item's `error`), never silent
 *   (e) idempotency per item
 *   (f) the client return contract is unchanged
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  proposalExecRegistry,
  dispatchProposalApproval,
  type ProposalExecutorArgs,
  type ProposalExecutorResult,
} from "../execution-registry.js";

// vitest cwd is the api package root (mirrors execute-executors.test.ts).
const API_SRC = join(process.cwd(), "src");
function readSrc(relFromApiSrc: string): string {
  return readFileSync(join(API_SRC, relFromApiSrc), "utf8");
}
function readRepo(relFromApiRoot: string): string {
  return readFileSync(join(process.cwd(), relFromApiRoot), "utf8");
}

const ROUTER = readSrc("routers/proposals.ts");
const EXECUTORS = readSrc("routers/proposals/approve-executors.ts");

/** `batchApprove`'s body (up to the next procedure). */
const BATCH_APPROVE_BLOCK = (() => {
  const start = ROUTER.indexOf("batchApprove: protectedProcedure");
  const end = ROUTER.indexOf("batchReject: protectedProcedure", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return ROUTER.slice(start, end);
})();

/** A minimal proposal row of the given type. */
function proposalRow(
  id: string,
  targetType: string,
  proposalType: string
): ProposalExecutorArgs["proposal"] {
  return {
    id,
    targetType,
    targetId: `${id}-target`,
    proposalType,
    workspaceId: "ws-1",
    sessionId: null,
    projectId: null,
    agentUserId: "agent-1",
    sourceMessageId: null,
    data: { source: "test" },
  };
}

function args(
  proposal: ProposalExecutorArgs["proposal"]
): ProposalExecutorArgs {
  return {
    proposal,
    payload: null,
    userId: "user-1",
    input: { proposalId: proposal.id },
    ctx: {} as ProposalExecutorArgs["ctx"],
    deps: {} as ProposalExecutorArgs["deps"],
  };
}

const noopOnFailed = async () => {};

beforeEach(() => proposalExecRegistry._reset());
afterEach(() => proposalExecRegistry._reset());

// ───────────────────────────────────────────────────────────────────────────
// (a) THE REGRESSION. A batched proposal whose key has NO materializer case
//     must invoke its SPECIFIC executor. Executable against the real dispatch.
// ───────────────────────────────────────────────────────────────────────────
describe("(a) a key with no materializer case runs its specific executor", () => {
  it("the materializer genuinely has no 'automation' case (why this matters)", () => {
    const materializer = readRepo("../jobs/src/workers/materializer.ts");
    expect(materializer).not.toContain('case "automation":');
    // …so the generic `.validated`-emit path — all batchApprove used to do —
    // provably cannot run an automation. Only the executor can.
  });

  it("an `automation/execute` executor exists to be resolved", () => {
    expect(EXECUTORS).toMatch(/key:\s*["']automation\/execute["']/);
  });

  it("dispatchProposalApproval RUNS it (not the catch-all)", async () => {
    const ran: string[] = [];
    proposalExecRegistry.register({
      key: "*/*",
      async execute() {
        ran.push("catch-all");
        return { success: true };
      },
    });
    proposalExecRegistry.register({
      key: "automation/execute",
      async execute() {
        ran.push("automation/execute");
        return { success: true };
      },
    });

    const result = await dispatchProposalApproval(
      args(proposalRow("p1", "automation", "execute")),
      noopOnFailed
    );

    expect(result).toEqual({ success: true });
    // The whole bug: this used to be [] for a batch approve, and would be
    // ["catch-all"] if the specific executor were shadowed.
    expect(ran).toEqual(["automation/execute"]);
  });

  it("every no-materializer-case key resolves to a SPECIFIC executor", async () => {
    // The ~20 keys the old inlined batch path silently no-op'd. Each must beat
    // the catch-all. (`capability.*` / `provider.action` / `messaging.*` are
    // proposalType-only keys — the second lookup step in resolve().)
    const registered = new Set<string>();
    proposalExecRegistry.register({
      key: "*/*",
      async execute() {
        registered.add("catch-all");
        return { success: true };
      },
    });
    for (const key of [
      "document/create",
      "channel/create_branch",
      "channel/merge_branch",
      "channel/create_external",
      "channel/bind",
      "property_def/create",
      "focus_session/create",
      "project/create",
      "project/archive",
      "skill/create",
      "automation/create",
      "automation/execute",
      "playbook/create",
      "playbook/promote",
      "messaging.external.send",
      "capability.run",
      "capability.install",
      "capability.enable",
      "provider.action",
      "capability/run",
    ]) {
      // Every one of these keys is really registered in approve-executors.ts…
      expect(EXECUTORS).toContain(`key: "${key}"`);
      proposalExecRegistry.register({
        key,
        async execute() {
          registered.add(key);
          return { success: true };
        },
      });
    }

    // …and each is what the shared dispatch actually reaches.
    for (const [targetType, proposalType] of [
      ["document", "create"],
      ["channel", "create_branch"],
      ["channel", "merge_branch"],
      ["channel", "create_external"],
      ["channel", "bind"],
      ["property_def", "create"],
      ["focus_session", "create"],
      ["project", "create"],
      ["project", "archive"],
      ["skill", "create"],
      ["automation", "create"],
      ["automation", "execute"],
      ["playbook", "create"],
      ["playbook", "promote"],
      ["message", "messaging.external.send"],
      ["capability", "capability.run"],
      ["capability", "capability.install"],
      ["capability", "capability.enable"],
      ["provider", "provider.action"],
      ["capability", "run"],
    ] as const) {
      await dispatchProposalApproval(
        args(
          proposalRow(
            `p-${targetType}-${proposalType}`,
            targetType,
            proposalType
          )
        ),
        noopOnFailed
      );
    }

    expect(registered.has("catch-all")).toBe(false);
    expect(registered.size).toBe(20);
  });

  it("an unregistered key still throws NOT_IMPLEMENTED (no silent success)", async () => {
    await expect(
      dispatchProposalApproval(
        args(proposalRow("p-x", "no_such_type", "no_such_verb")),
        noopOnFailed
      )
    ).rejects.toThrow(/not yet implemented/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) ONE door, two callers — the anti-drift invariant.
// ───────────────────────────────────────────────────────────────────────────
describe("(b) approve and batchApprove share one implementation", () => {
  it("batchApprove calls applyProposalApproval", () => {
    expect(BATCH_APPROVE_BLOCK).toContain("await applyProposalApproval({");
  });

  it("single approve calls the same function", () => {
    expect(ROUTER).toContain(
      "return await applyProposalApproval({ proposal, userId, input, ctx });"
    );
    // Exactly two call sites: the two approve doors. A third would be drift.
    expect(ROUTER.match(/await applyProposalApproval\(/g)?.length).toBe(2);
  });

  it("applyProposalApproval's tail IS the registry dispatch", () => {
    const start = ROUTER.indexOf("async function applyProposalApproval(");
    const end = ROUTER.indexOf("export const proposalsRouter", start);
    const fn = ROUTER.slice(start, end);
    expect(fn).toContain("return await dispatchProposalApproval(");
    expect(fn).toContain("ProposalStatus.APPROVAL_FAILED");
  });

  it("batchApprove no longer inlines its own materialization tail", () => {
    // The precise shape of the bug: a hand-rolled `.validated` emit + status
    // flip + reviewed-emit, with no executor resolution anywhere.
    expect(BATCH_APPROVE_BLOCK).not.toContain("auditLog(");
    expect(BATCH_APPROVE_BLOCK).not.toContain("isRequestShapedProposalData");
    expect(BATCH_APPROVE_BLOCK).not.toContain("ProposalStatus.APPROVED,");
    expect(BATCH_APPROVE_BLOCK).not.toContain("emitProposalReviewed(");
  });

  it("the registry is resolved from exactly one place in the router", () => {
    expect(ROUTER).not.toContain("proposalExecRegistry.resolve(");
    expect(ROUTER.match(/dispatchProposalApproval\(/g)?.length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c)+(d) partial failure: one item's throw must not sink the batch, and must
//         be VISIBLE. Executable mirror of batchApprove's loop driving the REAL
//         dispatch.
// ───────────────────────────────────────────────────────────────────────────
describe("(c/d) partial failure is isolated and visible", () => {
  /** Faithful mirror of batchApprove's per-item try/catch loop. */
  async function runBatch(
    ids: string[],
    failed: Array<{ proposalId: string; reason: string }>
  ) {
    const results: Array<{
      proposalId: string;
      success: boolean;
      error?: string;
    }> = [];
    for (const proposalId of ids) {
      try {
        const result = await dispatchProposalApproval(
          args(proposalRow(proposalId, "automation", "execute")),
          async (id, errorMessage) => {
            failed.push({ proposalId: id, reason: errorMessage });
          }
        );
        results.push({ proposalId, success: result.success });
      } catch (error) {
        results.push({
          proposalId,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
    return results;
  }

  it("item 3 of 10 throwing leaves 1-2 done and 4-10 still attempted", async () => {
    const executed: string[] = [];
    proposalExecRegistry.register({
      key: "automation/execute",
      async execute({ proposal }) {
        if (proposal.id === "p3") throw new Error("automation was deleted");
        executed.push(proposal.id);
        return { success: true };
      },
    });

    const failed: Array<{ proposalId: string; reason: string }> = [];
    const ids = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
    const results = await runBatch(ids, failed);

    expect(results).toHaveLength(10);
    expect(results.filter((r) => r.success).map((r) => r.proposalId)).toEqual([
      "p1",
      "p2",
      "p4",
      "p5",
      "p6",
      "p7",
      "p8",
      "p9",
      "p10",
    ]);
    // 4-10 really RAN — not merely reported success.
    expect(executed).toEqual([
      "p1",
      "p2",
      "p4",
      "p5",
      "p6",
      "p7",
      "p8",
      "p9",
      "p10",
    ]);
  });

  it("the failing item surfaces APPROVAL_FAILED + reason + a per-item error", async () => {
    proposalExecRegistry.register({
      key: "automation/execute",
      async execute({ proposal }) {
        if (proposal.id === "p3") throw new Error("automation was deleted");
        return { success: true };
      },
    });

    const failed: Array<{ proposalId: string; reason: string }> = [];
    const results = await runBatch(["p1", "p2", "p3"], failed);

    // Visible in the DB write the dispatch performs…
    expect(failed).toEqual([
      { proposalId: "p3", reason: "automation was deleted" },
    ]);
    // …and in the payload the client renders.
    expect(results[2]).toEqual({
      proposalId: "p3",
      success: false,
      error: "automation was deleted",
    });
  });

  it("batchApprove's loop really is per-item try/catch (no early abort)", () => {
    const tryIdx = BATCH_APPROVE_BLOCK.indexOf("try {");
    const callIdx = BATCH_APPROVE_BLOCK.indexOf(
      "await applyProposalApproval({"
    );
    const catchIdx = BATCH_APPROVE_BLOCK.indexOf("} catch (error) {");
    expect(tryIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeLessThan(callIdx);
    expect(callIdx).toBeLessThan(catchIdx);
    // The catch pushes a failed result and lets the loop continue — it must not
    // rethrow, which would abort the remaining items.
    const catchBody = BATCH_APPROVE_BLOCK.slice(catchIdx);
    expect(catchBody).toContain("success: false");
    expect(catchBody).not.toContain("throw ");
  });

  it("the loop is sequential (awaited in-order), not Promise.all", () => {
    expect(BATCH_APPROVE_BLOCK).toContain(
      "for (const proposalId of input.proposalIds)"
    );
    expect(BATCH_APPROVE_BLOCK).not.toContain("Promise.all");
    expect(BATCH_APPROVE_BLOCK).not.toContain("Promise.allSettled");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (e) idempotency per item — the same guard single approve has.
// ───────────────────────────────────────────────────────────────────────────
describe("(e) idempotency per item", () => {
  it("batchApprove skips every terminal status before dispatching", () => {
    expect(BATCH_APPROVE_BLOCK).toContain(
      "proposal.status !== ProposalStatus.PENDING"
    );
    expect(BATCH_APPROVE_BLOCK).toContain(
      "proposal.status !== ProposalStatus.APPROVAL_FAILED"
    );
    const guardIdx = BATCH_APPROVE_BLOCK.indexOf("Already ${proposal.status}");
    const callIdx = BATCH_APPROVE_BLOCK.indexOf(
      "await applyProposalApproval({"
    );
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(callIdx);
  });

  it("the executor's own already-APPROVED guard still short-circuits", async () => {
    let runs = 0;
    let status: "pending" | "approved" = "pending";
    proposalExecRegistry.register({
      key: "automation/execute",
      async execute(): Promise<ProposalExecutorResult> {
        if (status === "approved")
          return { success: true, alreadyApproved: true };
        runs++;
        status = "approved";
        return { success: true };
      },
    });

    const a = args(proposalRow("p1", "automation", "execute"));
    expect(await dispatchProposalApproval(a, noopOnFailed)).toEqual({
      success: true,
    });
    expect(await dispatchProposalApproval(a, noopOnFailed)).toEqual({
      success: true,
      alreadyApproved: true,
    });
    expect(runs).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (g) APPROVAL_FAILED: the terminal-failure path is recorded, surfaced, and
//     never mistaken for a successful approve by the outcome telemetry.
// ───────────────────────────────────────────────────────────────────────────
describe("(g) executor throw on approve -> APPROVAL_FAILED, never reported as approved", () => {
  it("onApprovalFailed gets (proposalId, message), the error is re-thrown, and reportProposalOutcome/emitAiCorrection never fire", async () => {
    proposalExecRegistry.register({
      key: "automation/execute",
      async execute() {
        // Real executors call deps.reportProposalOutcome (approve-executors.ts's
        // reportApproved helper) ONLY after the risky work succeeds — never
        // before. A throw here must leave it uncalled, exactly like this fake.
        throw new Error("automation was deleted");
      },
    });

    const reportProposalOutcome = vi.fn();
    // emitAiCorrection is not part of the registry-dispatch deps bag at all
    // (it's only invoked from applyProposalApproval's composite-proposal
    // branch in proposals.ts, which returns before ever reaching
    // dispatchProposalApproval) — so the registry path can't fire it by
    // construction. reportProposalOutcome IS deps-injected here, so it's the
    // one worth asserting directly.
    const a = args(proposalRow("p1", "automation", "execute"));
    a.deps = { ...a.deps, reportProposalOutcome } as typeof a.deps;

    const onApprovalFailed = vi.fn(async () => {});

    await expect(
      dispatchProposalApproval(a, onApprovalFailed)
    ).rejects.toThrow("automation was deleted");

    // The DB write proposals.ts's onApprovalFailed performs (status flip to
    // APPROVAL_FAILED + rejectionReason) is driven by exactly these args.
    expect(onApprovalFailed).toHaveBeenCalledTimes(1);
    expect(onApprovalFailed).toHaveBeenCalledWith(
      "p1",
      "automation was deleted"
    );
    expect(reportProposalOutcome).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (f) the client contract must not regress.
// ───────────────────────────────────────────────────────────────────────────
describe("(f) return shape is unchanged", () => {
  it("still returns { results: [{ proposalId, success, error? }] }", () => {
    expect(BATCH_APPROVE_BLOCK).toContain("const results: Array<{");
    expect(BATCH_APPROVE_BLOCK).toContain("proposalId: string;");
    expect(BATCH_APPROVE_BLOCK).toContain("success: boolean;");
    expect(BATCH_APPROVE_BLOCK).toContain("error?: string;");
    expect(BATCH_APPROVE_BLOCK).toContain("return { results };");
    // No field was removed from what the consumer destructures.
    expect(BATCH_APPROVE_BLOCK).toContain(
      "results.push({ proposalId, success: result.success })"
    );
  });
});
