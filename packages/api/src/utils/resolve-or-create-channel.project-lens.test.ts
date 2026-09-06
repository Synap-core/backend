import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The PROJECT LADDER, wired into a CONTAINER producer.
 *
 * Every `project_id` column in the pod already had a live producer and a live
 * consumer, yet fill rates sat at 0–10% (channels: 1%). The severance was
 * upstream of all of them: **every producer waited to be handed a project and
 * nothing derived one.** `resolveProjectPlacement` — the one deterministic
 * ladder — was consulted only by the two `belongs_to_project` EDGE writers.
 *
 * This exercises the REAL ladder through a REAL producer (`resolveOrCreateChannel`)
 * with only the database handle faked, so it pins three things at once:
 *
 *  1. a branch of a project-bound room INHERITS the project (the widening);
 *  2. an explicit project still WINS (rung 1 — today's behaviour, unchanged);
 *  3. **THE SAFETY PROPERTY** — when the ladder abstains, the producer writes
 *     NULL and invents nothing. Filing into a project is an exposure decision,
 *     so `NONE` ending the ladder is a property, not a gap. This is the one a
 *     later "helpful" fallback ("the only project", "the most recent project",
 *     an AI guess) would break, and nothing else in the tree would go red.
 *
 * The two SESSION producers (`openRunSession`, `createFocusSession`) live behind
 * a transaction + governance membrane and cannot be driven without Postgres;
 * their wiring is pinned by source-scan in
 * `__tripwires__/container-project-ladder-wiring.test.ts` instead.
 */

const PARENT_CHANNEL = "11111111-1111-4111-8111-111111111111";
const ENTITY = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "44444444-4444-4444-8444-444444444444";

type ChannelRow = {
  id: string;
  userId: string;
  workspaceId: string | null;
  projectId: string | null;
  status: string;
};

/** What the fake db is told to answer for this test. */
const state: {
  channel: ChannelRow | null;
  belongsToProject: Array<{ targetEntityId: string }>;
  inserted: Record<string, unknown> | null;
  channelLookups: number;
  relationLookups: number;
} = {
  channel: null,
  belongsToProject: [],
  inserted: null,
  channelLookups: 0,
  relationLookups: 0,
};

const fakeDb = {
  query: {
    channels: {
      findFirst: async () => {
        state.channelLookups += 1;
        return state.channel ?? undefined;
      },
    },
    relations: {
      findMany: async () => {
        state.relationLookups += 1;
        return state.belongsToProject;
      },
    },
    focusSessions: {
      findFirst: async () => undefined,
    },
  },
  // resolveSlugToAgentId: db.select({id}).from(agents).where(...).limit(1)
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: "agent-1" }],
      }),
    }),
  }),
  insert: () => ({
    values: (v: Record<string, unknown>) => ({
      returning: async () => {
        state.inserted = v;
        return [v];
      },
    }),
  }),
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return { ...actual, db: fakeDb };
});

// Imported AFTER the mock so the module binds the faked handle.
const { resolveOrCreateChannel } =
  await import("./resolve-or-create-channel.js");
const { ChannelType } = await import("@synap/database/schema");

beforeEach(() => {
  state.channel = null;
  state.belongsToProject = [];
  state.inserted = null;
  state.channelLookups = 0;
  state.relationLookups = 0;
});

describe("sub_thread inherits its parent room's project (rung 3)", () => {
  it("stamps the parent's project when the caller supplied none", async () => {
    state.channel = {
      id: PARENT_CHANNEL,
      userId: USER,
      workspaceId: WORKSPACE,
      projectId: "proj-parent",
      status: "active",
    };

    await resolveOrCreateChannel({
      userId: USER,
      channelType: ChannelType.SUB_THREAD,
      parentChannelId: PARENT_CHANNEL,
    });

    expect(
      state.inserted?.projectId,
      "a branch of a project-bound room must inherit the project — this is the " +
        "wiring that turns the 1% channel fill-rate around"
    ).toBe("proj-parent");
  });

  it("an explicit project still WINS — rung 1, today's behaviour unchanged", async () => {
    state.channel = {
      id: PARENT_CHANNEL,
      userId: USER,
      workspaceId: WORKSPACE,
      projectId: "proj-parent",
      status: "active",
    };

    await resolveOrCreateChannel({
      userId: USER,
      channelType: ChannelType.SUB_THREAD,
      parentChannelId: PARENT_CHANNEL,
      projectId: "proj-explicit",
    });

    expect(
      state.inserted?.projectId,
      "deriving must be a strict WIDENING of when a project is stamped, never a " +
        "change to which project an explicit caller gets"
    ).toBe("proj-explicit");
  });

  it("SAFETY — an abstaining ladder writes NULL and invents no project", async () => {
    state.channel = {
      id: PARENT_CHANNEL,
      userId: USER,
      workspaceId: WORKSPACE,
      projectId: null,
      status: "active",
    };

    await resolveOrCreateChannel({
      userId: USER,
      channelType: ChannelType.SUB_THREAD,
      parentChannelId: PARENT_CHANNEL,
    });

    expect(
      Object.prototype.hasOwnProperty.call(state.inserted ?? {}, "projectId"),
      "the producer must still name the column, not silently omit it"
    ).toBe(true);
    expect(
      state.inserted?.projectId,
      "no deterministic context means NO PROJECT. Filing into a project is an " +
        "exposure decision, so the ladder ending at NONE is a SAFETY PROPERTY — " +
        "never widen it with a default, 'the only project', or an AI guess"
    ).toBe(null);
  });
});

describe("thread on an entity inherits the entity's project (rung 4)", () => {
  it("stamps the subject entity's sole project", async () => {
    state.channel = null; // no existing thread → create
    state.belongsToProject = [{ targetEntityId: "proj-entity" }];

    await resolveOrCreateChannel({
      userId: USER,
      channelType: ChannelType.THREAD,
      workspaceId: WORKSPACE,
      contextObjectType: "entity",
      contextObjectId: ENTITY,
    });

    expect(state.inserted?.projectId).toBe("proj-entity");
  });

  it("SAFETY — a tie abstains rather than picking a winner", async () => {
    state.channel = null;
    state.belongsToProject = [
      { targetEntityId: "proj-a" },
      { targetEntityId: "proj-b" },
    ];

    await resolveOrCreateChannel({
      userId: USER,
      channelType: ChannelType.THREAD,
      workspaceId: WORKSPACE,
      contextObjectType: "entity",
      contextObjectId: ENTITY,
    });

    expect(
      state.inserted?.projectId,
      "a tie is an honest abstain — never a coin flip"
    ).toBe(null);
  });

  it("SAFETY — a NON-entity context object is never fed to the entity rung", async () => {
    state.channel = null;
    state.belongsToProject = [{ targetEntityId: "proj-should-not-be-used" }];

    await resolveOrCreateChannel({
      userId: USER,
      channelType: ChannelType.THREAD,
      workspaceId: WORKSPACE,
      contextObjectType: "document",
      contextObjectId: ENTITY,
    });

    expect(
      state.relationLookups,
      "a document/view/proposal id is not an entity id — passing it as " +
        "`relatedEntityIds` would be FABRICATING an input to make a rung fire"
    ).toBe(0);
    expect(state.inserted?.projectId).toBe(null);
  });
});
