/**
 * Seam test — the UNATTENDED playbook run (the scheduled path) refuses a
 * playbook whose skills are not enabled: it files the enable request on behalf
 * of the OWNER and throws the reason, BEFORE any session / channel / run row.
 * The automation executor records a thrown step error as the failed step's
 * reason and the run's `errorMessage` (automation-executor.ts, firstFailureMessage).
 *
 * Attended doors (`playbooks.run`) do not pass the flag — they refuse up front
 * with a structured answer instead — so without the flag nothing changes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const instantiateSession = vi.fn(async () => {
  throw new Error("REACHED_SESSION_CREATION");
});
const findUnenabledPlaybookSkills = vi.fn(async () => [
  { id: "skill-a", name: "source-triage" },
]);
const proposeCapabilityEnable = vi.fn(async () => [
  {
    status: "proposed",
    proposalId: "prop-1",
    reviewUrl: "https://pod/open/proposal/prop-1",
    originalActionRan: false,
  },
]);

vi.mock("./playbook-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRunnablePlaybook: async () => ({
    id: "pb-1",
    name: "Research a Question",
    goalTemplate: "Use the source-triage skill",
    inputStrategy: { kind: "none" },
    metadata: {},
  }),
  instantiateSession,
}));
vi.mock("./playbook-skill-preflight.js", () => ({
  findUnenabledPlaybookSkills,
}));
vi.mock("../capabilities/propose-capability-enable.js", () => ({
  proposeCapabilityEnable,
}));

const { runPlaybook } = await import("./run-playbook.js");

const INPUT = { playbookId: "pb-1", workspaceId: "ws-1", userId: "owner-1" };

describe("runPlaybook — unattended skill preflight", () => {
  beforeEach(() => {
    instantiateSession.mockClear();
    findUnenabledPlaybookSkills.mockClear();
    proposeCapabilityEnable.mockClear();
  });

  it("files the owner's enable request and fails with the reason — nothing is created", async () => {
    await expect(
      runPlaybook({ ...INPUT, unenabledSkillPreflight: true })
    ).rejects.toThrow(
      /^Nothing ran: "Research a Question" uses skills that are not enabled yet \(source-triage\)\. A request to enable them is waiting for the owner's review: https:\/\/pod\/open\/proposal\/prop-1$/
    );
    expect(proposeCapabilityEnable).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner-1", agentUserId: null })
    );
    expect(instantiateSession).not.toHaveBeenCalled();
  });

  it("without the flag (attended doors) the preflight does not run", async () => {
    await expect(runPlaybook(INPUT)).rejects.toThrow(
      "REACHED_SESSION_CREATION"
    );
    expect(findUnenabledPlaybookSkills).not.toHaveBeenCalled();
    expect(proposeCapabilityEnable).not.toHaveBeenCalled();
  });
});
