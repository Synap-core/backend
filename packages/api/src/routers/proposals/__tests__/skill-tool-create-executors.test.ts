/**
 * Two approval-path holes in the object-create executors.
 *
 * (A) skill/create — BORN-APPROVED ESCALATION (security).
 *     `insertSkillGoverned` (routers/skills.ts) decides approval with
 *     `approved = kind === "instruction" && !agentUserId` — an instruction skill
 *     is auto-approved only when a trusted HUMAN installs it, because its body
 *     lands verbatim in the agent's system prompt (prompt-injection vector).
 *     The `skill/create` executor MUST re-run that door with `agentUserId:
 *     undefined` — otherwise the agent branch of `checkPermissionOrPropose`
 *     fires again and the approval dead-ends in "unexpectedly re-proposed". But
 *     that operator identity also makes the born-approved rule read TRUE, so an
 *     AGENT-authored instruction skill materialized `approved: true` with no
 *     owner approval. The executor must restore the intended verdict from
 *     `proposal.agentUserId`.
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
// (A) skill/create — an agent-proposed instruction skill lands UNAPPROVED.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Executable mirror of the COMPOSED rule across the two files: the
 * insertSkillGoverned born-approved formula (skills.ts:310) as the executor
 * invokes it (agentUserId: undefined), followed by the executor's downgrade.
 * This is the end-state `approved` the DB row must hold after approval.
 */
/** Mirrors insertSkillGoverned's born-approved formula (routers/skills.ts:310). */
function insertSkillGovernedApproved(
  kind: string,
  agentUserId: string | undefined
): boolean {
  return kind === "instruction" && !agentUserId;
}

function approvedAfterSkillCreateApproval(args: {
  kind: string;
  /** The proposal row's author — set iff an AGENT authored the proposal. */
  proposalAgentUserId: string | null;
}): boolean {
  // insertSkillGoverned, re-run as the APPROVER (agentUserId is undefined).
  let approved = insertSkillGovernedApproved(args.kind, undefined);
  // The executor's downgrade, restoring the intended verdict.
  if (args.proposalAgentUserId && approved) approved = false;
  return approved;
}

describe("(A) skill/create approval — born-approved escalation is closed", () => {
  it("an AGENT-proposed instruction skill persists approved === false", () => {
    // The exploit: instruction body → agent system prompt with no owner review.
    expect(
      approvedAfterSkillCreateApproval({
        kind: "instruction",
        proposalAgentUserId: "agent-user-id",
      })
    ).toBe(false);
  });

  it("a HUMAN-proposed instruction skill is still born approved", () => {
    // Anti-vacuity: the downgrade must not flatten every skill to false, or the
    // assertion above would pass for the wrong reason.
    expect(
      approvedAfterSkillCreateApproval({
        kind: "instruction",
        proposalAgentUserId: null,
      })
    ).toBe(true);
  });

  it("executable kinds are unapproved on BOTH authorship paths", () => {
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

  it("the executor still re-runs the gate as the APPROVER (no re-propose)", () => {
    // Threading proposal.agentUserId into insertSkillGoverned instead would send
    // the gate down its AGENT branch, re-propose, and make the executor throw
    // "unexpectedly re-proposed" — a dead approval path.
    expect(SKILL_CREATE_BLOCK).toMatch(/agentUserId:\s*undefined/);
  });

  it("the executor downgrades on proposal.agentUserId (the source-level fix)", () => {
    // The pure mirror above proves the RULE; this proves the executor implements
    // it — an update of `skills.approved` to false, guarded on the proposal's
    // agent author.
    expect(SKILL_CREATE_BLOCK).toMatch(/if\s*\(\s*proposal\.agentUserId/);
    expect(SKILL_CREATE_BLOCK).toMatch(/\.update\(skills\)/);
    expect(SKILL_CREATE_BLOCK).toMatch(/approved:\s*false/);
  });

  it("insertSkillGoverned's rule is still the one it mirrors", () => {
    // If the formula in skills.ts changes, this mirror is stale — fail loudly.
    const skillsSrc = readSrc("routers/skills.ts");
    expect(skillsSrc).toMatch(
      /const approved = values\.kind === "instruction" && !agentUserId;/
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
      key,
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
