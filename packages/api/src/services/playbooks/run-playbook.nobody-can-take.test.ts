/**
 * The propose-mode rule's readiness gate asks the runner choice before a run
 * proposal is filed: an agent-only playbook that no agent can take files
 * nothing (a launch proposal nobody would run), with the reason.
 */

import { describe, it, expect, vi } from "vitest";

const route = vi.fn();
let executor = "external-agent";

vi.mock("../agent-dispatch/agent-assignment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readStoredRunChoice: async () => null,
}));
vi.mock("../agent-dispatch/route.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  route: (...args: unknown[]) => route(...args),
}));
vi.mock("./playbook-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveRunnablePlaybook: async () => ({
    id: "pb-1",
    name: "Enrich and score",
    goalTemplate: "Enrich it",
    executor,
    runner: null,
    inputStrategy: { kind: "none" },
    metadata: {},
  }),
}));
vi.mock("./playbook-skill-preflight.js", () => ({
  findUnenabledPlaybookSkills: async () => [],
}));

const { checkUnattendedPlaybookReadiness } = await import("./run-playbook.js");

const INPUT = { playbookId: "pb-1", workspaceId: "ws-1", userId: "owner-1" };

describe("checkUnattendedPlaybookReadiness: a run no runner can take", () => {
  it("an agent-only playbook with no agent bound for dispatch is not ready", async () => {
    executor = "external-agent";
    route.mockResolvedValue({ kind: "choose", candidates: [] });
    const out = await checkUnattendedPlaybookReadiness(INPUT);
    expect(out.ready).toBe(false);
    if (out.ready) return;
    expect(out.message).toMatch(
      /^Nothing filed: "Enrich and score" runs only on an agent, and none of your agents can take it\./
    );
  });

  it("an agent-only playbook an agent can take is ready", async () => {
    executor = "external-agent";
    route.mockResolvedValue({
      kind: "routed",
      agentUserId: "agent-1",
      reach: "dispatch",
      via: "single",
    });
    expect(await checkUnattendedPlaybookReadiness(INPUT)).toEqual({
      ready: true,
    });
  });

  it("a playbook Synap AI runs is ready whoever is bound", async () => {
    executor = "is-agent";
    route.mockResolvedValue({ kind: "choose", candidates: [] });
    expect(await checkUnattendedPlaybookReadiness(INPUT)).toEqual({
      ready: true,
    });
  });
});
