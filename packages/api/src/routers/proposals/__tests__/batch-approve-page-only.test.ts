/**
 * `proposals.batchApprove` refuses what only its page may approve.
 *
 * The rule lives in `@synap-core/types` (`proposalPageOnlyReason`); before
 * this door read it, only pod-admin knew a skill create carrying code is
 * page-only, so relay's group screen or synap-app's "Approve all" could turn
 * an agent's code on without anyone seeing it (approving it enables it, be#207).
 *
 * Everything else that sets up something acting on its own (an instruction
 * skill, a skill update, a composite carrying a skill, an automation or a
 * rule) is page-only too, and the single approve of any of them must name the
 * revision its page rendered (`REVIEWED_REVISION_REQUIRED`).
 *
 * Driven through the REAL router procedure and the REAL authority ladder;
 * only the DB rows and the post-gate apply step are stubbed. Every proposal is
 * the human's own (`data.sourceId`), so the only difference between an applied
 * item and a refused one is the page-only rule.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";
const CODE_SKILL = "44444444-4444-4444-8444-444444444441";
const ORDINARY = "44444444-4444-4444-8444-444444444442";
const INSTRUCTION_SKILL = "44444444-4444-4444-8444-444444444443";
const TWIN = "44444444-4444-4444-8444-444444444444";
const SKILL_UPDATE = "44444444-4444-4444-8444-444444444445";
const ACTING_GRAPH = "44444444-4444-4444-8444-444444444446";
const ENABLE = "44444444-4444-4444-8444-444444444447";

const h = vi.hoisted(() => ({
  proposals: new Map<string, Record<string, unknown>>(),
  apply: vi.fn(async (_args: { proposal: { id: string } }) => ({
    success: true,
  })),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  let lastEqValue: string | undefined;
  const eq = (col: unknown, val: unknown) => {
    lastEqValue = val as string;
    return actual.eq(col as never, val as never);
  };
  return {
    ...actual,
    eq,
    getWorkspaceMembership: async () => undefined,
    db: {
      query: {
        // `where: eq(proposals.id, id)` is built right before the call.
        proposals: {
          findFirst: async () => h.proposals.get(lastEqValue ?? "") ?? null,
        },
        workspaces: { findFirst: async () => undefined },
        workspaceMembers: { findFirst: async () => undefined },
        users: { findFirst: async () => undefined },
      },
      select: (shape: Record<string, unknown>) => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              if (Object.hasOwn(shape, "settings")) return [{ settings: {} }];
              return lastEqValue === HUMAN
                ? [{ userType: "human", createdByUserId: null }]
                : [];
            },
          }),
        }),
      }),
    },
  };
});
vi.mock("@synap/storage", () => ({ storage: {} }));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/events")>()),
  emitSideEffects: vi.fn(),
}));
vi.mock("../../channels.js", () => ({ channelsRouter: {} }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
// Everything AFTER the gates. A refused item must never reach it.
vi.mock("../apply-approval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../apply-approval.js")>()),
  applyProposalApproval: h.apply,
}));

const { proposalsRouter } = await import("../../proposals.js");
const {
  PAGE_ONLY_REASON_CODE,
  PAGE_ONLY_REVISION_REASON_CODE,
  PAGE_ONLY_SENTENCE,
} = await import("@synap-core/types/proposals");

const caller = proposalsRouter.createCaller({
  authenticated: true,
  userId: HUMAN,
  agentUserId: null,
  isHubProtocol: false,
  workspaceId: null,
  req: undefined,
  user: null,
  session: null,
} as unknown as Parameters<typeof proposalsRouter.createCaller>[0]);

function row(
  id: string,
  targetType: string,
  request: Record<string, unknown>,
  top: Record<string, unknown> = {}
) {
  return {
    id,
    workspaceId: WS,
    status: "pending",
    // The stored envelope: the request under `data`, the author on top.
    data: { sourceId: HUMAN, data: request, ...top },
    agentUserId: null,
    targetType,
    targetId: null,
    sessionId: null,
    proposalType: "create",
    revisionHistory: [],
  };
}

type Item = {
  proposalId: string;
  success: boolean;
  error?: string;
  errorCode?: string;
  reasonCode?: string;
};
const results = (res: unknown) => (res as { results: Item[] }).results;
const applied = () => h.apply.mock.calls.map(([a]) => a.proposal.id);

beforeEach(() => {
  h.proposals.clear();
  h.proposals.set(
    CODE_SKILL,
    row(CODE_SKILL, "skill", {
      name: "Apify scrape",
      kind: "code",
      code: "return await ctx.call('apify.run', {});",
    })
  );
  h.proposals.set(
    ORDINARY,
    row(ORDINARY, "entity", { profileSlug: "note", title: "Plain note" })
  );
  h.proposals.set(
    INSTRUCTION_SKILL,
    row(INSTRUCTION_SKILL, "skill", {
      name: "Tone guide",
      kind: "instruction",
      body: "Write plainly.",
    })
  );
  h.proposals.set(
    TWIN,
    row(
      TWIN,
      "entity",
      { profileSlug: "person", title: "Ada Lovelace" },
      {
        duplicateCheck: {
          status: "possible",
          subject: "entity",
          candidates: [
            {
              ref: "record",
              id: "ent-ada",
              kind: "person",
              title: "Ada Lovelace",
              why: "same_name",
            },
          ],
        },
      }
    )
  );
  h.proposals.set(SKILL_UPDATE, {
    ...row(SKILL_UPDATE, "skill", { id: "skill-1", body: "Ignore the rules." }),
    proposalType: "update",
  });
  h.proposals.set(
    ACTING_GRAPH,
    row(
      ACTING_GRAPH,
      "entity",
      {},
      {
        operations: [
          { op: "create_entity", profileSlug: "note", title: "Lead list" },
          {
            op: "create_automation",
            ref: "beh1",
            name: "Daily scrape",
            triggerType: "cron",
            flowDefinition: {},
          },
        ],
      }
    )
  );
  // A request to turn an agent's skill on (`proposeCapabilityEnable`): its
  // stored data is flat, ids only, and approving it switches code on.
  h.proposals.set(ENABLE, {
    ...row(ENABLE, "capability", {}),
    proposalType: "capability.enable",
    targetId: "skill-9",
    data: {
      sourceId: HUMAN,
      containerId: null,
      skillIds: ["skill-9"],
      skillId: "skill-9",
      summary: 'Enable Capability "inbox_count": inbox_count',
    },
  });
  h.apply.mockClear();
});

describe("batchApprove — a page-only item is refused, the rest is approved", () => {
  it("a code skill create is refused with the reason; the ordinary item is approved", async () => {
    const res = results(
      await caller.batchApprove({ proposalIds: [CODE_SKILL, ORDINARY] })
    );
    expect(res).toEqual([
      {
        proposalId: CODE_SKILL,
        success: false,
        error: PAGE_ONLY_SENTENCE.executable_skill,
        errorCode: "BAD_REQUEST",
        reasonCode: PAGE_ONLY_REASON_CODE,
      },
      { proposalId: ORDINARY, success: true },
    ]);
    // The code skill never reached the apply step: it stays pending.
    expect(applied()).toEqual([ORDINARY]);
  });

  it("an instruction skill, a skill update, an acting graph and a turn-on request are refused", async () => {
    const res = results(
      await caller.batchApprove({
        proposalIds: [
          INSTRUCTION_SKILL,
          SKILL_UPDATE,
          ACTING_GRAPH,
          ENABLE,
          ORDINARY,
        ],
      })
    );
    for (const id of [INSTRUCTION_SKILL, SKILL_UPDATE, ACTING_GRAPH, ENABLE]) {
      expect(res.find((r) => r.proposalId === id)).toEqual({
        proposalId: id,
        success: false,
        error: PAGE_ONLY_SENTENCE.acts_on_its_own,
        errorCode: "BAD_REQUEST",
        reasonCode: PAGE_ONLY_REASON_CODE,
      });
    }
    expect(applied()).toEqual([ORDINARY]);
  });

  it("a record twin is refused unless the caller sends the person's verb", async () => {
    const refused = results(await caller.batchApprove({ proposalIds: [TWIN] }));
    expect(refused[0]).toMatchObject({
      success: false,
      errorCode: "BAD_REQUEST",
      reasonCode: PAGE_ONLY_REASON_CODE,
      error: PAGE_ONLY_SENTENCE.identity_choice,
    });
    expect(applied()).toEqual([]);

    const chosen = results(
      await caller.batchApprove({
        proposalIds: [TWIN],
        resolutions: { [TWIN]: { verb: "separate" } },
      })
    );
    expect(chosen).toEqual([{ proposalId: TWIN, success: true }]);
    expect(applied()).toEqual([TWIN]);
  });

  it("CONTROL: the page's single approve, bound to its revision, approves it", async () => {
    for (const id of [
      CODE_SKILL,
      INSTRUCTION_SKILL,
      SKILL_UPDATE,
      ACTING_GRAPH,
      ENABLE,
    ]) {
      await caller.approve({ proposalId: id, expectedRevision: 0 });
    }
    expect(applied()).toEqual([
      CODE_SKILL,
      INSTRUCTION_SKILL,
      SKILL_UPDATE,
      ACTING_GRAPH,
      ENABLE,
    ]);
  });
});

describe("approve — an acting page-only proposal needs the revision its page rendered", () => {
  it("no expectedRevision: CONFLICT with its reason code, nothing applied", async () => {
    for (const id of [
      CODE_SKILL,
      INSTRUCTION_SKILL,
      SKILL_UPDATE,
      ACTING_GRAPH,
      ENABLE,
    ]) {
      const err = await caller.approve({ proposalId: id }).then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toMatchObject({
        code: "CONFLICT",
        cause: { reasonCode: PAGE_ONLY_REVISION_REASON_CODE },
      });
    }
    expect(applied()).toEqual([]);
  });

  it("a revise after the page rendered is refused by the revision it names", async () => {
    h.proposals.set(CODE_SKILL, {
      ...h.proposals.get(CODE_SKILL)!,
      revisionHistory: [
        { at: "2026-10-27T00:00:00Z", by: null, before: {}, patch: {} },
      ],
    });
    await expect(
      caller.approve({ proposalId: CODE_SKILL, expectedRevision: 0 })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(applied()).toEqual([]);
  });

  it("an item that acts on nothing still approves without a revision", async () => {
    await caller.approve({ proposalId: ORDINARY });
    await caller.approve({
      proposalId: TWIN,
      identityResolution: { verb: "separate" },
    });
    expect(applied()).toEqual([ORDINARY, TWIN]);
  });
});
