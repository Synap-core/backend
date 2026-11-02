/**
 * TRIPWIRE — every SELF-GATED builtin verb files its own review.
 *
 * `SELF_GATED_BUILTIN_VERBS` (execute-capability.ts) lets a verb RUN when the
 * outer capability gate would have filed a generic `capability.run`
 * proposal, on one promise: the verb hands `mustPropose` to an inner gate
 * that files a proposal and acts on nothing. A verb added to the set without
 * keeping that promise would turn every review into an action — an app's
 * send would go out with no one approving it.
 *
 * Two halves:
 *  1. Each listed verb has a PROBE here that drives its real handler under
 *     `mustPropose` and sees the inner gate receive it. A verb with no probe
 *     fails: adding one to the set means adding its proof.
 *  2. The outer door: on a `propose` verdict, `executeCapability` runs a
 *     self-gated verb with `mustPropose` and returns ITS proposal (never a
 *     capability-run row); any other verdict is untouched (a dry-run runs
 *     nothing).
 *
 * The inner gate's own half (`mustPropose` files a messaging.external.send
 * proposal and the provider is never called) runs for real on PGlite in
 * `connectors/channel-send.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  sendInputs: [] as Array<Record<string, unknown>>,
  gateDecision: {
    decision: "propose",
    reasonCode: "APP_OUTWARD_INTENT",
  } as Record<string, unknown>,
  skillRow: {} as Record<string, unknown>,
  capabilityProposals: [] as Array<Record<string, unknown>>,
}));

const CHANNEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // One select shape serves both reads: the skill row (execute-capability)
  // and the channel row (messaging.send with a channelId).
  const rows = (table: unknown) =>
    table === (actual as Record<string, unknown>).channels
      ? [
          {
            id: CHANNEL,
            workspaceId: null,
            channelType: "external",
            metadata: { accountId: "acc-1" },
          },
        ]
      : [h.skillRow];
  return {
    ...actual,
    getWorkspaceMembership: async () => ({ role: "owner" }),
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const r = rows(table);
            return {
              limit: async () => r,
              orderBy: () => ({ limit: async () => r }),
              then: (resolve: (v: unknown) => unknown) => resolve(r),
            };
          },
        }),
      }),
    },
  };
});
vi.mock("../connectors/external-dispatch.js", () => ({
  sendExternalMessage: async (input: Record<string, unknown>) => {
    h.sendInputs.push(input);
    return input.mustPropose
      ? { success: false, proposed: true, proposalId: "inner-proposal" }
      : { success: true };
  },
}));
vi.mock("../services/capabilities/gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => h.gateDecision,
  CAPABILITY_RUN_PROPOSAL: { targetType: "capability", proposalType: "run" },
}));
vi.mock("../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPendingProposal: async (input: Record<string, unknown>) => {
    h.capabilityProposals.push(input);
    return { id: "outer-proposal" };
  },
}));

const { SELF_GATED_BUILTIN_VERBS, executeCapability } =
  await import("../services/capabilities/execute-capability.js");
const { BUILTIN_VERBS } =
  await import("../services/capabilities/builtin-verbs.js");

/** Per verb: params that reach its inner gate, and what proves it got `mustPropose`. */
const PROBES: Record<
  string,
  { params: Record<string, unknown>; innerGateSaw: () => unknown }
> = {
  "messaging.send": {
    params: { channelId: CHANNEL, content: "hello" },
    innerGateSaw: () => h.sendInputs.at(-1)?.mustPropose,
  },
};

beforeEach(() => {
  h.sendInputs.length = 0;
  h.capabilityProposals.length = 0;
  h.gateDecision = { decision: "propose", reasonCode: "APP_OUTWARD_INTENT" };
});

describe("every self-gated builtin verb hands mustPropose to its inner gate", () => {
  it("the set is not empty and every member has a probe", () => {
    expect(SELF_GATED_BUILTIN_VERBS.size).toBeGreaterThan(0);
    for (const verb of SELF_GATED_BUILTIN_VERBS) {
      expect(
        PROBES[verb],
        `no probe for self-gated verb "${verb}"`
      ).toBeDefined();
      expect(BUILTIN_VERBS[verb], `no handler for "${verb}"`).toBeDefined();
    }
  });

  it.each([...SELF_GATED_BUILTIN_VERBS])(
    "%s, run with mustPropose, passes it to the inner gate",
    async (verb) => {
      const probe = PROBES[verb]!;
      await BUILTIN_VERBS[verb]!(probe.params, {
        userId: "owner-1",
        workspaceId: null,
        mustPropose: true,
      });
      expect(probe.innerGateSaw()).toBe(true);
    }
  );
});

describe("the outer door hands a propose verdict down, never a capability run", () => {
  it.each([...SELF_GATED_BUILTIN_VERBS])(
    "%s: a propose verdict returns the verb's own proposal",
    async (verb) => {
      h.skillRow = {
        id: "11111111-1111-4111-8111-111111111111",
        name: verb,
        approved: true,
        userId: "owner-1",
        kind: "builtin",
        providerSpec: null,
        parameters: null,
        metadata: null,
      };
      const out = await executeCapability({
        verbId: verb,
        parameters: PROBES[verb]!.params,
        workspaceId: null,
        userId: "owner-1",
      });
      expect(out).toMatchObject({
        kind: "proposed",
        proposalId: "inner-proposal",
      });
      expect(PROBES[verb]!.innerGateSaw()).toBe(true);
      expect(h.capabilityProposals).toHaveLength(0);
    }
  );

  it("a dry-run verdict stays a dry-run: the verb never runs", async () => {
    h.gateDecision = { decision: "dry-run" };
    h.skillRow = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "messaging.send",
      approved: true,
      userId: "owner-1",
      kind: "builtin",
      providerSpec: null,
      parameters: null,
      metadata: null,
    };
    const out = await executeCapability({
      verbId: "messaging.send",
      parameters: { channelId: CHANNEL, content: "hello" },
      workspaceId: null,
      userId: "owner-1",
    });
    expect(out.kind).toBe("dry-run");
    expect(h.sendInputs).toHaveLength(0);
  });
});
