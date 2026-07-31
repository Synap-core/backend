import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StepContext } from "../automation-executor.js";

// The channel_message output resolves its target channel through the
// ChannelRepository resolvers + insertChannelMessage door. Mock ONLY those two
// exports of @synap/database (keep the rest real via importOriginal) so we can
// assert WHICH resolver each config shape drives — the context-derived routing
// precedence is the load-bearing behavior of this wave.
const mocks = vi.hoisted(() => ({
  ensureEntityChannel: vi.fn(),
  ensureAutomationRunChannel: vi.fn(),
  ensureUserPersonalChannel: vi.fn(),
  ensureProactiveFeedChannel: vi.fn(),
  insertChannelMessage: vi.fn(),
  // The rows the channelEntityRef existence-lookup resolves to. Non-empty = the
  // referenced entity exists (route to its channel); empty = unknown ref (fall
  // through to the default run channel, never dangle/throw).
  entityLookupRows: [] as Array<{ id: string }>,
  // The row the explicit-`channelId` SCOPE re-validation resolves to. Defined =
  // the channel is reachable from the automation's workspace; undefined = it is
  // not (the executor must refuse to post). Row-level proof that the PREDICATE
  // is the right one lives in channel-message-scope.test.ts.
  channelScopeRow: undefined as { id: string } | undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  class ChannelRepository {
    constructor(_db: unknown) {}
    ensureEntityChannel = mocks.ensureEntityChannel;
    ensureAutomationRunChannel = mocks.ensureAutomationRunChannel;
    ensureUserPersonalChannel = mocks.ensureUserPersonalChannel;
    ensureProactiveFeedChannel = mocks.ensureProactiveFeedChannel;
  }
  // Minimal db stub — of the output types, only channel_message's
  // channelEntityRef existence-check reads db in this test file. Return the
  // per-test configured rows from the select().from().where().limit() chain.
  // NOTE: this stub ignores the where-predicate — scope-predicate correctness
  // (workspaceId/deletedAt) is NOT covered here; real scope coverage needs an
  // integration PG test.
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mocks.entityLookupRows),
        }),
      }),
    }),
    query: {
      channels: {
        findFirst: () => Promise.resolve(mocks.channelScopeRow),
      },
    },
  };
  return {
    ...actual,
    db,
    ChannelRepository,
    insertChannelMessage: mocks.insertChannelMessage,
  };
});

// Import AFTER the mock is registered so the executor picks up the mocked exports.
const { executeOutputStep } = await import("../automation-executor.js");

const OWNER = "user-owner";
const WORKSPACE = "ws-1";

const context = (steps: StepContext["steps"] = {}): StepContext => ({
  trigger: { payload: {} },
  steps,
  automation: { id: "auto-1", state: {} },
});

const automationContext = {
  automationRunId: "run-1",
  automationId: "auto-1",
  chainDepth: 0,
  rootRunId: "run-1",
  chainAutomationIds: [] as string[],
};

const runChannelMessage = (
  config: Record<string, unknown>,
  opts: { steps?: StepContext["steps"]; subjectEntityId?: string | null } = {}
) =>
  executeOutputStep(
    { outputType: "channel_message", config },
    context(opts.steps),
    WORKSPACE,
    automationContext,
    OWNER,
    OWNER,
    { nodeId: "node-cm", stepRunId: "sr-1" },
    opts.subjectEntityId
  );

describe("channel_message output — context-derived channel routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureEntityChannel.mockResolvedValue({ id: "ch-entity" });
    mocks.ensureAutomationRunChannel.mockResolvedValue({ id: "ch-run" });
    mocks.ensureUserPersonalChannel.mockResolvedValue({ id: "ch-personal" });
    mocks.ensureProactiveFeedChannel.mockResolvedValue({ id: "ch-proactive" });
    mocks.insertChannelMessage.mockResolvedValue({});
    // Default: the referenced entity EXISTS (channelEntityRef routes to it).
    mocks.entityLookupRows = [{ id: "found" }];
    // Default: the explicit channel IS in scope for the automation's workspace.
    mocks.channelScopeRow = { id: "in-scope" };
  });

  it("(a) explicit channelId wins — no resolver invoked", async () => {
    const result = await runChannelMessage({
      channelId: "ch-explicit",
      content: "hi",
    });
    expect(mocks.ensureEntityChannel).not.toHaveBeenCalled();
    expect(mocks.ensureAutomationRunChannel).not.toHaveBeenCalled();
    expect(mocks.insertChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "ch-explicit", content: "hi" })
    );
    expect(result).toMatchObject({ status: "sent", channelId: "ch-explicit" });
  });

  // SECURITY: the explicit-channelId branch is the ONLY one that takes a
  // caller-supplied destination verbatim, and the sink (insertChannelMessage) is
  // a bare insert with no visibility check. Before the run-time re-validation, a
  // flow definition naming ANY channel uuid posted into it under the owner's
  // identity. The refusal must be LOUD — falling through to the run channel
  // would still deliver the content, just somewhere the author did not name.
  it("(a) SECURITY — an out-of-scope explicit channelId refuses to post (no insert, no silent fallback)", async () => {
    mocks.channelScopeRow = undefined; // not reachable from WORKSPACE
    await expect(
      runChannelMessage({ channelId: "ch-foreign", content: "secret" })
    ).rejects.toThrow(/ch-foreign is not reachable from workspace ws-1/);
    expect(mocks.insertChannelMessage).not.toHaveBeenCalled();
    expect(mocks.ensureAutomationRunChannel).not.toHaveBeenCalled();
  });

  it("(b) channelEntityRef (exact {{...}} → entity id) resolves via ensureEntityChannel", async () => {
    const result = await runChannelMessage(
      { channelEntityRef: "{{steps.q.output.clientId}}", content: "recap" },
      { steps: { q: { output: { clientId: "entity-42" } } } }
    );
    expect(mocks.ensureEntityChannel).toHaveBeenCalledWith(
      "entity-42",
      OWNER,
      WORKSPACE
    );
    expect(mocks.ensureAutomationRunChannel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "sent", channelId: "ch-entity" });
  });

  it("(c) channelType:'subjectEntity' routes the run's subject via ensureEntityChannel", async () => {
    const result = await runChannelMessage(
      { channelType: "subjectEntity", content: "recap" },
      { subjectEntityId: "entity-subject" }
    );
    expect(mocks.ensureEntityChannel).toHaveBeenCalledWith(
      "entity-subject",
      OWNER,
      WORKSPACE
    );
    expect(result).toMatchObject({ status: "sent", channelId: "ch-entity" });
  });

  it("(c) channelType:'personal_thread' resolves the user's personal channel", async () => {
    await runChannelMessage({ channelType: "personal_thread", content: "x" });
    expect(mocks.ensureUserPersonalChannel).toHaveBeenCalledWith(OWNER);
    expect(mocks.ensureAutomationRunChannel).not.toHaveBeenCalled();
  });

  it("(d) DEFAULT — targetless posts to the automation's own run channel (no throw)", async () => {
    const result = await runChannelMessage({ content: "digest" });
    expect(mocks.ensureAutomationRunChannel).toHaveBeenCalledWith(
      "auto-1",
      OWNER,
      WORKSPACE
    );
    expect(mocks.ensureEntityChannel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "sent", channelId: "ch-run" });
  });

  it("channelEntityRef resolving to an empty value falls through to the run channel (no throw, no dangle)", async () => {
    const result = await runChannelMessage(
      { channelEntityRef: "{{steps.q.output.clientId}}", content: "x" },
      { steps: { q: { output: { clientId: "" } } } }
    );
    expect(mocks.ensureEntityChannel).not.toHaveBeenCalled();
    expect(mocks.ensureAutomationRunChannel).toHaveBeenCalledWith(
      "auto-1",
      OWNER,
      WORKSPACE
    );
    expect(result).toMatchObject({ status: "sent", channelId: "ch-run" });
  });

  it("channelEntityRef pointing at a nonexistent entity falls through to the run channel (never dangles a void channel)", async () => {
    mocks.entityLookupRows = []; // the referenced entity does not exist
    const result = await runChannelMessage(
      { channelEntityRef: "{{steps.q.output.clientId}}", content: "x" },
      { steps: { q: { output: { clientId: "ghost-entity" } } } }
    );
    expect(mocks.ensureEntityChannel).not.toHaveBeenCalled();
    expect(mocks.ensureAutomationRunChannel).toHaveBeenCalledWith(
      "auto-1",
      OWNER,
      WORKSPACE
    );
    expect(result).toMatchObject({ status: "sent", channelId: "ch-run" });
  });

  it("still requires content", async () => {
    await expect(runChannelMessage({ channelId: "ch-1" })).rejects.toThrow(
      /channel_message requires content/
    );
  });
});
