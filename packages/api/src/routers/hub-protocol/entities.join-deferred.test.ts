/**
 * #6 join deferral at the Hub doors (create + update): a write KEPT on a
 * workspace-JOIN request reaches the agent as `{ deferred: true, ref }` with
 * the "replayed for you — do not resend" words, never "retry the write".
 *
 * The REAL hub procedures; the regular `entities.create` / `.update` doors
 * (which read `perm.deferred` off the gate) are replaced by their join-gate
 * answer. The gate keeping the write is pinned on PGlite by
 * `services/governance/deferred-writes.pglite.test.ts`.
 *
 * NOT covered here, stated: that `entities/create.ts` and `entities/mutate.ts`
 * copy `perm.deferred` / `perm.deferredRef` onto their result — those doors are
 * mocked. A join gate WITHOUT `deferred` (an unreplayable pair) keeps the old
 * "retry after approval" words — pinned below so the two cannot be swapped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  answer: {} as Record<string, unknown>,
}));

vi.mock("../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../middleware/api-key-auth.js")>();
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return { ...actual, scopedProcedure: () => t.procedure };
});
vi.mock("./utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils.js")>()),
  createHubProtocolCallerContext: async (userId: string) => ({ userId }),
}));
vi.mock("../entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      create: async () => h.answer,
      update: async () => h.answer,
    }),
  },
}));

import { entitiesRouter as hubEntitiesRouter } from "./entities.js";
import { JOIN_GATE_DEFERRED_MESSAGE } from "../../utils/permission-check.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ENTITY = "33333333-3333-4333-8333-333333333333";

const caller = () =>
  hubEntitiesRouter.createCaller({
    userId: USER,
    agentUserId: AGENT,
    scopes: ["hub-protocol.write"],
  } as never);

const kept = {
  status: "proposed",
  message: JOIN_GATE_DEFERRED_MESSAGE,
  proposalId: "join-1",
  proposalType: "join",
  reviewUrl: "https://pod/open/join-1",
  deferred: true,
  ref: "dw-1",
};

beforeEach(() => {
  h.answer = kept;
});

describe("hub entities — a write kept on a join", () => {
  it("createEntity forwards deferred + ref", async () => {
    const out = (await caller().createEntity({
      userId: USER,
      profileSlug: "note",
      title: "Call notes",
    } as never)) as Record<string, unknown>;
    expect(out).toMatchObject({
      status: "proposed",
      proposalType: "join",
      deferred: true,
      ref: "dw-1",
      message: JOIN_GATE_DEFERRED_MESSAGE,
    });
  });

  it("updateEntity forwards deferred + ref, and says do not resend", async () => {
    const out = (await caller().updateEntity({
      entityId: ENTITY,
      userId: USER,
      title: "Renamed",
    })) as Record<string, unknown>;
    expect(out).toMatchObject({
      status: "proposed",
      proposalType: "join",
      deferred: true,
      ref: "dw-1",
      message: JOIN_GATE_DEFERRED_MESSAGE,
      reasoning: JOIN_GATE_DEFERRED_MESSAGE,
    });
    expect(String(out.message)).toMatch(/do not resend/);
  });

  it("a join that did NOT keep the write still says retry after approval", async () => {
    h.answer = { ...kept, deferred: undefined, ref: undefined };
    const out = (await caller().updateEntity({
      entityId: ENTITY,
      userId: USER,
      title: "Renamed",
    })) as Record<string, unknown>;
    expect(out).not.toHaveProperty("deferred");
    expect(String(out.message)).toMatch(/retry the write/);
  });
});
