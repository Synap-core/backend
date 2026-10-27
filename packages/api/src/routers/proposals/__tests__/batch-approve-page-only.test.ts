/**
 * `proposals.batchApprove` refuses what only its page may approve.
 *
 * The rule lives in `@synap-core/types` (`proposalPageOnlyReason`); before
 * this door read it, only pod-admin knew a skill create carrying code is
 * page-only, so relay's group screen or synap-app's "Approve all" could turn
 * an agent's code on without anyone seeing it (approving it enables it, be#207).
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
const { PAGE_ONLY_REASON_CODE, PAGE_ONLY_SENTENCE } =
  await import("@synap-core/types/proposals");

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

  it("an instruction skill runs nothing and may be batched", async () => {
    const res = results(
      await caller.batchApprove({ proposalIds: [INSTRUCTION_SKILL] })
    );
    expect(res).toEqual([{ proposalId: INSTRUCTION_SKILL, success: true }]);
    expect(applied()).toEqual([INSTRUCTION_SKILL]);
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

  it("CONTROL: the code skill's own page (single approve) still approves it", async () => {
    await caller.approve({ proposalId: CODE_SKILL });
    expect(applied()).toEqual([CODE_SKILL]);
  });
});
