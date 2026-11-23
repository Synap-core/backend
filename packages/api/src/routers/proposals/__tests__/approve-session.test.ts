/**
 * `proposals.approveSession` — the person approves a whole session from its
 * page. Rows chosen where the rules disagree with `batchApprove`:
 *  - an item that acts on its own (a code skill, a graph with an automation)
 *    passes HERE bound to the revision the page rendered, and is refused by
 *    the batch door and by this door without that revision;
 *  - a same-name twin still needs its own page (a choice, not a review);
 *  - a proposal the session does not hold is refused, never applied;
 *  - what makes a space is approved before what lands in it, whatever order
 *    the items were filed or sent in.
 * Everything after the gates (`applyProposalApproval`) is a recorder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const WS = "33333333-3333-4333-8333-333333333333";
const CODE_SKILL = "44444444-4444-4444-8444-444444444441";
const ORDINARY = "44444444-4444-4444-8444-444444444442";
const TWIN = "44444444-4444-4444-8444-444444444444";
const ACTING_GRAPH = "44444444-4444-4444-8444-444444444446";

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
          // The session read: every row asked for; the door keeps the
          // session's own.
          findMany: async () => [...h.proposals.values()],
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
const { PAGE_ONLY_REASON_CODE } = await import("@synap-core/types/proposals");

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

const SESSION = "55555555-5555-4555-8555-555555555555";
const SPACE = "44444444-4444-4444-8444-444444444448";
const PLAYBOOK = "44444444-4444-4444-8444-444444444449";

beforeEach(() => {
  h.apply.mockClear();
  h.proposals.clear();
  const inSession = (r: Record<string, unknown>, at: string) => ({
    ...r,
    sessionId: SESSION,
    createdAt: new Date(at),
  });
  h.proposals.set(
    CODE_SKILL,
    inSession(
      row(CODE_SKILL, "skill", {
        name: "Apify scrape",
        kind: "code",
        code: "return await ctx.call('apify.run', {});",
      }),
      "2026-11-01T10:00:00Z"
    )
  );
  h.proposals.set(
    ACTING_GRAPH,
    inSession(
      row(
        ACTING_GRAPH,
        "composite",
        {},
        {
          operations: [
            {
              op: "create_automation",
              ref: "beh1",
              name: "Daily scrape",
              triggerType: "cron",
              flowDefinition: { nodes: [], edges: [] },
            },
          ],
        }
      ),
      "2026-11-01T10:01:00Z"
    )
  );
  h.proposals.set(
    PLAYBOOK,
    inSession(
      row(PLAYBOOK, "playbook", { name: "Qualify" }),
      "2026-11-01T09:00:00Z"
    )
  );
  h.proposals.set(
    SPACE,
    inSession(
      row(SPACE, "workspace", { name: "Radar" }),
      "2026-11-01T11:00:00Z"
    )
  );
  h.proposals.set(
    TWIN,
    inSession(
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
      ),
      "2026-11-01T10:02:00Z"
    )
  );
  // Filed in another session: never this door's to approve.
  h.proposals.set(ORDINARY, {
    ...row(ORDINARY, "entity", { profileSlug: "note", title: "Plain note" }),
    sessionId: "66666666-6666-4666-8666-666666666666",
  });
});

const approveSession = (ids: string[]) =>
  caller.approveSession({
    sessionId: SESSION,
    expectedRevisions: Object.fromEntries(ids.map((id) => [id, 0])),
  });

describe("approveSession — the session page approves what it showed", () => {
  it("an item that acts on its own passes here, bound to its revision; the batch door refuses it", async () => {
    const res = results(await approveSession([CODE_SKILL, ACTING_GRAPH]));
    expect(res.every((r) => r.success)).toBe(true);
    expect(applied().sort()).toEqual([ACTING_GRAPH, CODE_SKILL].sort());

    h.apply.mockClear();
    const batch = results(
      await caller.batchApprove({
        proposalIds: [CODE_SKILL],
        expectedRevisions: { [CODE_SKILL]: 0 },
      })
    );
    expect(batch[0]!.reasonCode).toBe(PAGE_ONLY_REASON_CODE);
    expect(applied()).toEqual([]);
  });

  it("a same-name twin still needs its own page", async () => {
    const res = results(await approveSession([TWIN]));
    expect(res[0]).toMatchObject({
      success: false,
      reasonCode: PAGE_ONLY_REASON_CODE,
    });
    expect(applied()).toEqual([]);
  });

  it("a proposal the session does not hold is refused, never applied", async () => {
    const res = results(await approveSession([ORDINARY]));
    expect(res[0]).toMatchObject({ success: false, errorCode: "NOT_FOUND" });
    expect(applied()).toEqual([]);
  });

  it("the space is approved before what lands in it, whatever the filing order", async () => {
    await approveSession([PLAYBOOK, ACTING_GRAPH, SPACE]);
    expect(applied()).toEqual([SPACE, PLAYBOOK, ACTING_GRAPH]);
  });
});
