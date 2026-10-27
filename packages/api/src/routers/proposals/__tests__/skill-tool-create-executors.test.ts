/**
 * Two approval-path holes in the object-create executors.
 *
 * (A) skill/create — ONE approval, never an escalation (security).
 *     The executor re-runs `insertSkillGoverned` with `agentUserId: undefined`
 *     (otherwise the agent branch of `checkPermissionOrPropose` fires again
 *     and the approval dead-ends in "unexpectedly re-proposed"), so the row it
 *     writes reads the APPROVER as the author. The executor then applies THE
 *     rule (`skillBornApproved`) with the proposal's real author and who
 *     approved: a PERSON's approval turns the skill on (one approval — founder
 *     decision 2); anything else keeps an agent-authored skill OFF (an
 *     instruction body lands in an agent's system prompt).
 *
 * (B) tool/create — UNRECOVERABLE PROPOSAL.
 *     `tools.create` gated the write but stored only `{name, kind}`, and no
 *     `tool/create` executor existed — so approval fell to the wildcard
 *     catch-all executor,
 *     which flips the proposal APPROVED and emits the audit event while
 *     INSERTING NOTHING. Success was reported and the request was unrecoverable.
 *
 * Style follows the sibling suites (workspace-create-executor.test.ts,
 * execute-executors.test.ts): the api suite needs live Postgres for anything
 * touching `db`, so these are source-level contracts + EXECUTABLE pure-logic
 * mirrors of the exact composed rule.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  proposalExecRegistry,
  type ProposalExecutor,
  type ProposalExecutorResult,
} from "../execution-registry.js";
import { readExecutorsSource } from "./read-executors-source.js";
import { skillBornApproved } from "../../../services/capabilities/skill-born-approved.js";

// vitest cwd is the api package root.
const API_SRC = join(process.cwd(), "src");
function readSrc(relFromApiSrc: string): string {
  return readFileSync(join(API_SRC, relFromApiSrc), "utf8");
}

const EXECUTORS = readExecutorsSource(API_SRC);

/**
 * Slice one executor body out of the registration file. Throws (rather than
 * silently returning "") when a marker moves — an empty block would make every
 * assertion below pass VACUOUSLY.
 */
function executorBlock(startKey: string, endKey: string): string {
  const start = EXECUTORS.indexOf(`key: "${startKey}"`);
  const end = EXECUTORS.indexOf(`key: "${endKey}"`, start);
  if (start < 0 || end <= start) {
    throw new Error(
      `executorBlock: cannot slice ${startKey}..${endKey} (start=${start} end=${end}) — markers moved`
    );
  }
  return EXECUTORS.slice(start, end);
}

/** The `skill/create` executor body (up to the next registration). */
const SKILL_CREATE_BLOCK = executorBlock("skill/create", "tool/create");

/** The `tool/create` executor body (up to the next registration). */
const TOOL_CREATE_BLOCK = executorBlock("tool/create", "automation/create");

// ───────────────────────────────────────────────────────────────────────────
// (A) skill/create — a person's approval turns it on; nothing else does.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The end-state `approved` after a `skill/create` approval: the executor
 * corrects whatever row `insertSkillGoverned` wrote as the APPROVER to THE
 * rule's verdict for the proposal's real author and who approved. The REAL
 * rule, not a mirror; the executor's wiring of it (the correction, the enable
 * door) is driven in `skill-create-approval-wiring.test.ts`.
 */
function approvedAfterSkillCreateApproval(args: {
  kind: string;
  code?: string | null;
  providerSpec?: unknown;
  /** The proposal row's author — set iff an AGENT authored the proposal. */
  proposalAgentUserId: string | null;
  /** A PERSON (not an agent path) clicked approve. */
  approvedByPerson?: boolean;
}): boolean {
  return skillBornApproved({
    kind: args.kind,
    code: args.code ?? null,
    providerSpec: args.providerSpec ?? null,
    agentUserId: args.proposalAgentUserId,
    personApprovedProposal: args.approvedByPerson,
  });
}

describe("(A) skill/create approval — one approval, no escalation", () => {
  it("an AGENT-proposed instruction skill NOT approved by a person persists approved === false", () => {
    // The exploit: instruction body → agent system prompt with no owner review.
    expect(
      approvedAfterSkillCreateApproval({
        kind: "instruction",
        proposalAgentUserId: "agent-user-id",
      })
    ).toBe(false);
  });

  it("an AGENT-proposed skill a PERSON approved lands approved, whatever its kind", () => {
    for (const kind of ["instruction", "code", "declarative"]) {
      expect(
        approvedAfterSkillCreateApproval({
          kind,
          proposalAgentUserId: "agent-user-id",
          approvedByPerson: true,
        })
      ).toBe(true);
    }
  });

  it("a HUMAN-proposed instruction skill is still born approved", () => {
    // Anti-vacuity: the verdict must not flatten every skill to false, or the
    // first assertion would pass for the wrong reason.
    expect(
      approvedAfterSkillCreateApproval({
        kind: "instruction",
        proposalAgentUserId: null,
      })
    ).toBe(true);
  });

  it("executable kinds no person approved are unapproved on BOTH authorship paths", () => {
    for (const agent of [null, "agent-user-id"]) {
      for (const kind of ["code", "declarative"]) {
        expect(
          approvedAfterSkillCreateApproval({
            kind,
            proposalAgentUserId: agent,
          })
        ).toBe(false);
      }
    }
  });

  it("an instruction LABEL on code or a provider spec is not prose: never born approved unreviewed", () => {
    for (const carries of [
      { code: "return 1;" },
      { providerSpec: { tool: "x" } },
    ]) {
      expect(
        approvedAfterSkillCreateApproval({
          kind: "instruction",
          ...carries,
          proposalAgentUserId: null,
        })
      ).toBe(false);
    }
  });

  it("the executor still re-runs the gate as the APPROVER (no re-propose)", () => {
    // Threading proposal.agentUserId into insertSkillGoverned instead would send
    // the gate down its AGENT branch, re-propose, and make the executor throw
    // "unexpectedly re-proposed" — a dead approval path.
    expect(SKILL_CREATE_BLOCK).toMatch(/agentUserId:\s*undefined/);
  });

  it("every born-approved site reads the ONE rule", () => {
    // The create doors and the executor must agree, or one becomes the bypass.
    const skillsSrc = readSrc("routers/skills.ts");
    expect(skillsSrc.match(/skillBornApproved\(\{/g)?.length).toBe(2);
    expect(skillsSrc).not.toMatch(/kind === "instruction" && !/);
    expect(SKILL_CREATE_BLOCK).toMatch(/skillBornApproved\(\{/);
    expect(SKILL_CREATE_BLOCK).toMatch(
      /agentUserId:\s*proposal\.agentUserId,\s*personApprovedProposal:\s*approvedByPerson/
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (B) tool/create — an approved tool proposal MATERIALIZES.
// ───────────────────────────────────────────────────────────────────────────

describe("(B) tool/create approval materializes instead of no-op", () => {
  it("an executor is registered for the key", () => {
    expect(EXECUTORS).toMatch(/key:\s*["']tool\/create["']/);
  });

  it("the exact key wins over the wildcard catch-all", () => {
    const mk = (key: string): ProposalExecutor => ({
      key: key as ProposalExecutor["key"],
      execute: async (): Promise<ProposalExecutorResult> => ({ success: true }),
    });
    const catchAll = mk("*/*");
    const exact = mk("tool/create");
    proposalExecRegistry._reset();
    proposalExecRegistry.register(catchAll);
    proposalExecRegistry.register(exact);
    expect(proposalExecRegistry.resolve("tool/create", "create")).toBe(exact);
    // Other tool verbs still fall through to the generic path.
    expect(proposalExecRegistry.resolve("tool/pause", "pause")).toBe(catchAll);
    proposalExecRegistry._reset();
  });

  it("it inserts a tool row and seeds the enforcement grant", () => {
    expect(TOOL_CREATE_BLOCK).toMatch(/\.insert\(tools\)/);
    expect(TOOL_CREATE_BLOCK).toContain("issueCapabilityGrant");
  });

  it("it carries the idempotency guard (re-approve must not double-create)", () => {
    expect(TOOL_CREATE_BLOCK).toContain("alreadyApproved");
  });

  it("it preserves the proposing agent as author", () => {
    expect(TOOL_CREATE_BLOCK).toMatch(/createdBy:\s*proposal\.agentUserId/);
  });

  it("tools.create stores the FULL insert shape on the gate, not name-only", () => {
    // The bug: `data: { name, kind }` only — approval could never rebuild the
    // tool, so the request was unrecoverable.
    const toolsSrc = readSrc("routers/tools.ts");
    const permBlock = toolsSrc.slice(
      toolsSrc.indexOf("checkPermissionOrPropose"),
      toolsSrc.indexOf('if ("denied"')
    );
    for (const field of [
      "inputSchema",
      "credentialRef",
      "executor",
      "config",
      "metadata",
      "workspaceId",
    ]) {
      expect(permBlock).toContain(`${field}:`);
    }
  });
});
