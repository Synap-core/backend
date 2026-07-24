/**
 * Approve-executors for the two proposal-GATED execution verbs:
 *   `{automation, execute}` (automations.trigger) and
 *   `{command, execute}`   (hub-protocol POST /commands/execute).
 *
 * The UX cliff being closed: a gated verb with no approve-executor falls through
 * to the wildcard catch-all executor, which flips the proposal APPROVED and emits
 * a `<subject>.<action>.validated` event — but the thing only actually RUNS if
 * the materializer worker has a case for that subject. `command` has one
 * (`materializeCommand`); `automation` does NOT — so approving an automation run
 * was a silent no-op until the `automation/execute` executor landed.
 *
 * Same no-DB style as workspace-create-executor.test.ts / channel-bind-proposal
 * .test.ts (the api suite needs live Postgres for anything touching the db, so
 * these invariants are proven statically + with executable pure-logic mirrors).
 *
 * Coverage:
 *   (a) automation.execute / command.execute really ARE proposal-gated
 *   (b) an `automation/execute` executor is registered, re-entering the SAME door
 *   (c) it cannot re-trigger the gate (no agentUserId on the re-entry)
 *   (d) idempotency: the prevailing already-APPROVED guard
 *   (e) registry precedence: the exact key wins over the wildcard (executable)
 *   (f) command/execute deliberately has NO executor — the catch-all path
 *       materializes it WITH its safety controls; shadowing it would bypass them
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import ts from "typescript";
import {
  DEFAULT_AUTO_APPROVE,
  isAutoApproved,
  decideAgentPolicy,
} from "@synap/governance-policy";
import {
  proposalExecRegistry,
  type ProposalExecutorResult,
} from "../execution-registry.js";

// vitest cwd is the api package root (mirrors workspace-create-executor.test.ts).
const API_SRC = join(process.cwd(), "src");
function readSrc(relFromApiSrc: string): string {
  return readFileSync(join(API_SRC, relFromApiSrc), "utf8");
}
function readRepo(relFromApiRoot: string): string {
  return readFileSync(join(process.cwd(), relFromApiRoot), "utf8");
}

const EXECUTORS = readSrc("routers/proposals/approve-executors.ts");

/** The `automation/execute` executor body (up to the next registration). */
const AUTOMATION_EXEC_BLOCK = (() => {
  const start = EXECUTORS.indexOf('key: "automation/execute"');
  const end = EXECUTORS.indexOf('key: "playbook/create"', start);
  return EXECUTORS.slice(start, end);
})();

/**
 * AST view of the `automation/execute` executor.
 *
 * Substring-scanning the whole executor body cannot tell "this identifier is an
 * argument to the trigger call" from "this identifier appears in a comment or in
 * an unrelated telemetry call in the same function" — and that is exactly how the
 * `agentUserId` assertion below fired falsely when `deps.reportProposalOutcome({
 * …, agentUserId: proposal.agentUserId, … })` was (correctly) added. Parsing gives
 * the assertion the scope it always meant: the caller CONTEXT literal and the
 * TRIGGER arguments, and nothing else. Comments are not part of the AST at all.
 */
const AUTOMATION_EXEC_AST = (() => {
  const sf = ts.createSourceFile(
    "approve-executors.ts",
    EXECUTORS,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );

  /** The object literal registered under key "automation/execute". */
  let executorObject: ts.ObjectLiteralExpression | undefined;
  const findExecutor = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keyProp = node.properties.find(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "key" &&
          ts.isStringLiteral(p.initializer) &&
          p.initializer.text === "automation/execute"
      );
      if (keyProp) executorObject = node;
    }
    if (!executorObject) ts.forEachChild(node, findExecutor);
  };
  findExecutor(sf);

  /**
   * Every property NAME written anywhere inside the arguments of the call whose
   * callee is `<something>.<methodName>` — i.e. what the executor actually hands
   * to that call, nested object literals included.
   */
  const propertyNamesPassedTo = (
    methodName: string
  ): { found: boolean; names: string[] } => {
    if (!executorObject) return { found: false, names: [] };
    const names: string[] = [];
    let found = false;

    const visitCall = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === methodName
      ) {
        found = true;
        const collect = (n: ts.Node): void => {
          if (
            (ts.isPropertyAssignment(n) ||
              ts.isShorthandPropertyAssignment(n)) &&
            (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
          ) {
            names.push(n.name.text);
          }
          ts.forEachChild(n, collect);
        };
        for (const arg of node.arguments) collect(arg);
      }
      ts.forEachChild(node, visitCall);
    };
    visitCall(executorObject);
    return { found, names };
  };

  return {
    get parsed(): boolean {
      return executorObject !== undefined;
    },
    callerContext: propertyNamesPassedTo("createCaller"),
    triggerInput: propertyNamesPassedTo("trigger"),
  };
})();

// ───────────────────────────────────────────────────────────────────────────
// (a) both verbs are genuinely gated — the cliff only matters if approval is
//     on the real path.
// ───────────────────────────────────────────────────────────────────────────
describe("(a) automation.execute / command.execute are proposal-gated", () => {
  it("neither is in DEFAULT_AUTO_APPROVE (nor matched by a wildcard)", () => {
    expect(DEFAULT_AUTO_APPROVE).not.toContain("automation.execute");
    expect(DEFAULT_AUTO_APPROVE).not.toContain("command.execute");
    expect(isAutoApproved("automation.execute", DEFAULT_AUTO_APPROVE)).toBe(
      false
    );
    expect(isAutoApproved("command.execute", DEFAULT_AUTO_APPROVE)).toBe(false);
  });

  it("decideAgentPolicy proposes both (agent path, default policy)", () => {
    expect(
      decideAgentPolicy({ subjectType: "automation", action: "execute" })
        .verdict
    ).toBe("propose");
    expect(
      decideAgentPolicy({ subjectType: "command", action: "execute" }).verdict
    ).toBe("propose");
  });

  it("automations.trigger gates the agent path on {automation, execute}", () => {
    const src = readSrc("routers/automations.ts");
    const block = src.slice(src.indexOf("  trigger: protectedProcedure"));
    expect(block).toContain("checkPermissionOrPropose");
    expect(block).toMatch(/subjectType:\s*["']automation["']/);
    expect(block).toMatch(/action:\s*["']execute["']/);
    // The gate's `data` is the executor's ONLY source of truth for the run.
    expect(block).toMatch(/automationId:\s*existing\.id/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) the executor exists and re-enters the SAME door (no reimplementation).
// ───────────────────────────────────────────────────────────────────────────
describe("(b) automation/execute executor re-enters automations.trigger", () => {
  it("registers key automation/execute", () => {
    expect(EXECUTORS).toMatch(/key:\s*["']automation\/execute["']/);
    expect(AUTOMATION_EXEC_BLOCK.length).toBeGreaterThan(0);
  });

  it("materializes through automationsRouter.trigger, not a hand-rolled run", () => {
    expect(AUTOMATION_EXEC_BLOCK).toContain("automationsRouter");
    expect(AUTOMATION_EXEC_BLOCK).toContain(".trigger({");
    // It must NOT reimplement the run: no direct run insert, no queue send.
    expect(AUTOMATION_EXEC_BLOCK).not.toContain("automationRuns");
    expect(AUTOMATION_EXEC_BLOCK).not.toContain("automation-execute");
    expect(AUTOMATION_EXEC_BLOCK).not.toContain("getBoss");
  });

  it("identifies the automation by data.automationId, never proposals.targetId", () => {
    // The gate data carries no id/entityId/documentId, so targetId is a RANDOM
    // uuid for this key — reading it would trigger a phantom automation.
    expect(AUTOMATION_EXEC_BLOCK).toContain("innerData.automationId");
    expect(AUTOMATION_EXEC_BLOCK).not.toContain("proposal.targetId");
  });

  it("surfaces failure instead of swallowing it (no try/catch around the run)", () => {
    // The dispatch site in proposals.ts records APPROVAL_FAILED + re-throws, so
    // an executor must let the error propagate.
    expect(AUTOMATION_EXEC_BLOCK).not.toContain("catch");
    const proposalsSrc = readSrc("routers/proposals.ts");
    expect(proposalsSrc).toContain("ProposalStatus.APPROVAL_FAILED");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) the re-entry cannot re-trigger the gate — the infinite-proposal hazard.
// ───────────────────────────────────────────────────────────────────────────
describe("(c) re-entering the door cannot re-trigger the gate", () => {
  it("the executor passes NO agentUserId (ctx or input)", () => {
    // Structural, not textual: assert on the properties the executor actually
    // hands to `automationsRouter.createCaller(...)` and to
    // `automationCaller.trigger(...)`. Threading an agent identity into EITHER
    // makes `trigger` resolve an agentUserId, re-enter checkPermissionOrPropose
    // and spawn ANOTHER proposal from an approval — an infinite proposal loop.
    // Unrelated correct code elsewhere in the same executor (e.g. the
    // `deps.reportProposalOutcome({ …, agentUserId, … })` telemetry report,
    // which MUST keep attributing the change to the proposing agent) is out of
    // scope by construction here.
    expect(AUTOMATION_EXEC_AST.parsed).toBe(true);

    // Both call sites must be FOUND — otherwise "no agentUserId" would pass
    // vacuously if the executor were ever restructured away from these calls.
    expect(AUTOMATION_EXEC_AST.callerContext.found).toBe(true);
    expect(AUTOMATION_EXEC_AST.triggerInput.found).toBe(true);

    expect(AUTOMATION_EXEC_AST.callerContext.names).not.toContain(
      "agentUserId"
    );
    expect(AUTOMATION_EXEC_AST.triggerInput.names).not.toContain("agentUserId");

    // Positive lock on the shape the invariant depends on: the ctx literal is
    // exactly the anonymous-operator context, and trigger gets only the run
    // arguments. A new key on either side is a deliberate decision that must
    // re-read the loop hazard above.
    expect(AUTOMATION_EXEC_AST.callerContext.names.sort()).toEqual([
      "authenticated",
      "db",
      "userId",
    ]);
    expect(AUTOMATION_EXEC_AST.triggerInput.names.sort()).toEqual([
      "id",
      "payload",
      "subjectEntityId",
    ]);
  });

  it("automations.trigger only gates when an agentUserId is resolved", () => {
    const src = readSrc("routers/automations.ts");
    const block = src.slice(src.indexOf("  trigger: protectedProcedure"));
    expect(block).toContain(
      "const agentUserId = input.agentUserId ?? ctx.agentUserId ?? undefined;"
    );
    // The gate lives INSIDE `if (agentUserId) {` — an undefined agent skips it.
    const gateIdx = block.indexOf("checkPermissionOrPropose");
    const guardIdx = block.indexOf("if (agentUserId) {");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(guardIdx);
  });

  it("still fails loudly if trigger ever returned a proposal from approval", () => {
    expect(AUTOMATION_EXEC_BLOCK).toContain('result.status !== "triggered"');
  });

  /** Executable mirror of trigger's gate guard. */
  function wouldGate(
    input: { agentUserId?: string },
    ctx: { agentUserId?: string }
  ) {
    return Boolean(input.agentUserId ?? ctx.agentUserId ?? undefined);
  }
  it("gate guard is false for the executor's caller shape (pure mirror)", () => {
    expect(wouldGate({}, {})).toBe(false); // executor re-entry
    expect(wouldGate({ agentUserId: "a" }, {})).toBe(true); // agent door
    expect(wouldGate({}, { agentUserId: "a" })).toBe(true); // hub ctx door
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (d) idempotency — approving twice must not run the flow twice.
// ───────────────────────────────────────────────────────────────────────────
describe("(d) idempotency follows the prevailing already-APPROVED guard", () => {
  it("short-circuits on ProposalStatus.APPROVED before touching the door", () => {
    expect(AUTOMATION_EXEC_BLOCK).toContain("ProposalStatus.APPROVED");
    expect(AUTOMATION_EXEC_BLOCK).toContain("alreadyApproved: true");
    const guardIdx = AUTOMATION_EXEC_BLOCK.indexOf("alreadyApproved: true");
    const runIdx = AUTOMATION_EXEC_BLOCK.indexOf(".trigger({");
    expect(guardIdx).toBeLessThan(runIdx);
  });

  it("uses the same guard shape as the other create/run executors", () => {
    // automation/create and cell/define both select proposals.status by id.
    for (const key of ['key: "automation/create"', 'key: "cell/define"']) {
      const start = EXECUTORS.indexOf(key);
      const block = EXECUTORS.slice(start, start + 2500);
      expect(block).toContain("ProposalStatus.APPROVED");
      expect(block).toContain("alreadyApproved: true");
    }
  });

  /** Executable mirror: second approve is a no-op run-wise. */
  it("a second approve does not re-enter the door (pure mirror)", async () => {
    let runs = 0;
    let status: "pending" | "approved" = "pending";
    const execute = async (): Promise<ProposalExecutorResult> => {
      if (status === "approved")
        return { success: true, alreadyApproved: true };
      runs++;
      status = "approved";
      return { success: true };
    };
    expect(await execute()).toEqual({ success: true });
    expect(await execute()).toEqual({ success: true, alreadyApproved: true });
    expect(runs).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (e) registry precedence — the mechanism the fix depends on.
// ───────────────────────────────────────────────────────────────────────────
describe("(e) an exact key wins over the catch-all", () => {
  it("resolve('automation/execute') prefers the exact executor", () => {
    const exact = {
      key: "automation/execute",
      execute: async () => ({ success: true }),
    };
    const catchAll = {
      key: "*/*",
      execute: async () => ({ success: false }),
    };
    proposalExecRegistry._reset();
    proposalExecRegistry.register(catchAll);
    proposalExecRegistry.register(exact);
    expect(proposalExecRegistry.resolve("automation/execute", "execute")).toBe(
      exact
    );
    // Any other automation verb still falls through to the generic path.
    expect(proposalExecRegistry.resolve("automation/pause", "pause")).toBe(
      catchAll
    );
    proposalExecRegistry._reset();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (f) command/execute is deliberately NOT given an executor.
// ───────────────────────────────────────────────────────────────────────────
describe("(f) command/execute stays on the catch-all + materializer path", () => {
  it("no command/execute executor is registered", () => {
    // Registering one would SHADOW the catch-all, suppress the
    // `command.execute.validated` emit, and require reimplementing the shell
    // runner — including BLOCKED_COMMAND_PATTERNS / validateWorkingDir /
    // buildSafeEnv, all module-private to hub-protocol/rest/commands.ts.
    expect(EXECUTORS).not.toMatch(/key:\s*["']command\/execute["']/);
  });

  it("the materializer DOES handle subjectType 'command'", () => {
    const materializer = readRepo("../jobs/src/workers/materializer.ts");
    expect(materializer).toContain('case "command":');
    expect(materializer).toContain("materializeCommand");
    // …and re-applies the working-dir + env controls on the approved run.
    expect(materializer).toContain("validateWorkingDir");
    expect(materializer).toContain("buildSafeEnv");
  });

  it("the direct command door blocks dangerous commands BEFORE proposing", () => {
    // This is why materializeCommand does not need to re-run the pattern list:
    // a blocked command never becomes a proposal in the first place.
    const src = readSrc("routers/hub-protocol/rest/commands.ts");
    const blockIdx = src.indexOf(
      "for (const pattern of BLOCKED_COMMAND_PATTERNS)"
    );
    const gateIdx = src.indexOf("checkPermissionOrPropose");
    expect(blockIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(blockIdx);
    expect(src.indexOf("validateWorkingDir(workingDir)")).toBeLessThan(gateIdx);
    expect(src.indexOf("checkCommandRateLimit(workspaceId)")).toBeLessThan(
      gateIdx
    );
  });

  it("the materializer has NO 'automation' case — why (b) is required", () => {
    const materializer = readRepo("../jobs/src/workers/materializer.ts");
    expect(materializer).not.toContain('case "automation":');
  });
});
