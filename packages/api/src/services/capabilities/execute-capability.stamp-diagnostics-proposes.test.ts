/**
 * Seam test — `document.stamp_diagnostics` is a WRITE: an agent's run of it is
 * PROPOSED, while the report flow (an automation running as its human owner)
 * still runs it.
 *
 * Founder decision 2026-10-21: the verb went into `READ_ONLY_BUILTIN_VERBS` in
 * cb3c40f05 ("annotation, not a data write → auto-run") and comes back out —
 * it writes `documents.metadata.diagnostics`, so an agent must ask.
 *
 * Drives the REAL `executeCapability` through the REAL `gateCapabilityExecution`
 * (`@synap/capability-gate`): only the skill read, the gate's grant / rule /
 * origin lookups, and the proposal insert are stubbed. The gate is wrapped, not
 * replaced, so each case asserts the verdict the real ladder reached from the
 * `readOnly` flag the execute door computed. A `run` verdict throws `RAN` from
 * the wrapper so no handler executes here (the handler has its own PGlite
 * suite, `stamp-run-diagnostics.pglite.test.ts`).
 *
 * The discriminating row is `document.freeze_charts`, a READ that stays in the
 * set: the same agent, the same harness, and it runs. A harness that proposed
 * everything would fail there.
 *
 * NOT covered: the jobs automation door itself (`runVerbOnRouter` in
 * `command-skill-capability.ts`). The "report flow" case below calls the API
 * door with the arguments that door passes (the automation owner as `userId`,
 * no `agentUserId`); that it passes exactly those is read, not tested here.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POD_OWNER = "pod-owner";
const MEMBER = "member-1";
const AGENT = "agent-1";

const proposals: any[] = [];
const verdicts: Array<{ readOnly: unknown; decision: string }> = [];
const RAN = new Error("RAN: the gate said run");

let skillRow: Record<string, unknown> = {};
const builtin = (name: string) => ({
  id: `skill-${name}`,
  name,
  approved: true,
  // Synap Core builtins are seeded by, and owned by, the pod owner.
  userId: POD_OWNER,
  kind: "builtin",
  providerSpec: null,
  metadata: {},
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [skillRow] }),
          }),
        }),
      }),
    },
    getDb: async () => ({}),
    // The agent holds NO grant on any verb.
    findCapabilityGrant: async () => ({ ok: false }),
  };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // No stored capability rule widens the run.
    resolveGovernanceRule: async () => undefined,
    // No channel context: origin trust no-ops.
    resolveOriginTrust: async () => undefined,
  };
});

vi.mock("./gate-capability-execution.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./gate-capability-execution.js")>();
  return {
    ...actual,
    gateCapabilityExecution: async (
      input: Parameters<typeof actual.gateCapabilityExecution>[0]
    ) => {
      const decision = await actual.gateCapabilityExecution(input);
      verdicts.push({ readOnly: input.readOnly, decision: decision.decision });
      if (decision.decision === "run") throw RAN;
      return decision;
    },
  };
});

vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createPendingProposal: async (input: any) => {
      proposals.push(input);
      return { id: `prop-${proposals.length}` };
    },
  };
});

const { executeCapability } = await import("./execute-capability.js");

const STAMP_PARAMS = {
  documentId: "doc-1",
  items: [
    {
      code: "freeze_failed",
      severity: "warning",
      message: "A chart stayed live.",
      fix: "Open the report and make it live again.",
    },
  ],
};

describe("document.stamp_diagnostics proposes for an agent (founder 2026-10-21)", () => {
  beforeEach(() => {
    proposals.length = 0;
    verdicts.length = 0;
  });

  it("an agent's run is PROPOSED, with the call carried intact", async () => {
    skillRow = builtin("document.stamp_diagnostics");
    const out = (await executeCapability({
      verbId: "document.stamp_diagnostics",
      parameters: STAMP_PARAMS,
      workspaceId: WS,
      userId: MEMBER,
      agentUserId: AGENT,
    })) as { kind: string };

    expect(verdicts).toEqual([{ readOnly: false, decision: "propose" }]);
    expect(out.kind).toBe("proposed");
    expect(proposals).toHaveLength(1);
    expect(proposals[0].agentUserId).toBe(AGENT);
    expect(proposals[0].data.verbId).toBe("document.stamp_diagnostics");
    expect(proposals[0].data.parameters).toEqual(STAMP_PARAMS);
  });

  it("DISCRIMINATING ROW: the same agent's READ (document.freeze_charts) still runs", async () => {
    skillRow = builtin("document.freeze_charts");
    await expect(
      executeCapability({
        verbId: "document.freeze_charts",
        parameters: { markdown: "No charts here." },
        workspaceId: WS,
        userId: MEMBER,
        agentUserId: AGENT,
      })
    ).rejects.toBe(RAN);

    expect(verdicts).toEqual([{ readOnly: true, decision: "run" }]);
    expect(proposals).toHaveLength(0);
  });

  it.each([
    ["the pod owner", POD_OWNER],
    ["a member who is not the verb's owner", MEMBER],
  ])(
    "the report flow (an automation owned by %s, no agent) still runs it",
    async (_who, owner) => {
      skillRow = builtin("document.stamp_diagnostics");
      await expect(
        executeCapability({
          verbId: "document.stamp_diagnostics",
          parameters: STAMP_PARAMS,
          workspaceId: WS,
          userId: owner,
        })
      ).rejects.toBe(RAN);

      expect(verdicts).toEqual([{ readOnly: false, decision: "run" }]);
      expect(proposals).toHaveLength(0);
    }
  );
});
