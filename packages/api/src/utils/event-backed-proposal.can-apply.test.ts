/**
 * `createEventBackedProposal` asks the one filing check (`can-apply.ts`)
 * BEFORE it writes the `.requested` audit event (plan 8032a127 D1): a
 * proposal its approval would refuse leaves no event behind it, and the pending
 * door is told the check was asked (`canApplyAsked`), so it is not asked twice.
 *
 * Driven through the REAL `createEventBackedProposal` and the REAL check (the
 * `command/execute` entry reads nothing), mocked only at its two outbound
 * seams: the audit stamp and the pending door. No `agentUserId`, so the dedup
 * peek never runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { auditLog, createPendingProposal } = vi.hoisted(() => ({
  auditLog: vi.fn(async () => ({ id: "evt-1" })),
  createPendingProposal: vi.fn(async () => ({ id: "prop-1" })),
}));

vi.mock("./audit-log.js", () => ({ auditLog }));
vi.mock("./permission-check.js", () => ({ createPendingProposal }));

const { createEventBackedProposal } =
  await import("./event-backed-proposal.js");
const { ProposalCannotApplyError } =
  await import("../services/proposals/can-apply.js");

const command = (cmd: string) => ({
  userId: "user-1",
  workspaceId: null,
  targetType: "command",
  targetId: "c1",
  proposalType: "execute",
  data: { command: cmd },
});

describe("createEventBackedProposal asks the filing check before its event", () => {
  beforeEach(() => {
    auditLog.mockClear();
    createPendingProposal.mockClear();
  });

  it("a proposal its approval would refuse: refused, NO .requested event, nothing filed", async () => {
    const err = await createEventBackedProposal(
      command("echo $(whoami)")
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProposalCannotApplyError);
    expect(err).toMatchObject({ reasonCode: "COMMAND_REFUSED" });
    expect(auditLog).not.toHaveBeenCalled();
    expect(createPendingProposal).not.toHaveBeenCalled();
  });

  it("one that can apply: one event, then filed with the check already asked", async () => {
    await createEventBackedProposal(command("ls -la"));
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(createPendingProposal).toHaveBeenCalledTimes(1);
    expect(createPendingProposal.mock.calls[0]).toEqual([
      expect.objectContaining({
        targetType: "command",
        proposalType: "execute",
      }),
      undefined,
      { canApplyAsked: true },
    ]);
  });
});
