/**
 * channel_message `config.channelId` SCOPE re-validation — the row-level
 * security proof.
 *
 * THE VULNERABILITY THIS PINS: of the four ways a `channel_message` output picks
 * its destination, three derive it from run context through a ChannelRepository
 * resolver (and `channelEntityRef` proves its entity is in scope first). The
 * fourth — an explicit `config.channelId` — was taken VERBATIM from the stored
 * flow definition and handed straight to `insertChannelMessage`, which is a bare
 * insert with no channel visibility check. A definition naming an arbitrary
 * channel uuid therefore posted into that channel at run time under the
 * automation owner's identity, and kept doing so across lens changes, workspace
 * moves and membership revocation, because nothing re-validated at execution.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM channel-message-routing.test.ts: that
 * file's db stub ignores where-predicates, so it can only prove the executor
 * *reacts* to a lookup miss — not that the predicate is the RIGHT one. Here the
 * four drizzle operators are mocked as tagged boolean-tree nodes (the
 * `ledger-query-scope.test.ts` / `entity-query-scope.test.ts` pattern) and a
 * small interpreter evaluates the REAL predicate the executor builds against a
 * fixture channels table. Columns are identified by REFERENCE to the actual
 * schema objects, so the test cannot drift into re-implementing the code.
 *
 * The claims:
 *   (a) a channel in the automation's OWN workspace is reachable,
 *   (b) a POD-WIDE channel (workspace_id NULL) is reachable from a
 *       workspace-scoped automation — substrate channels stay addressable,
 *   (c) a channel in ANOTHER workspace is REFUSED — the cross-workspace leak,
 *   (d) a POD-WIDE automation (workspace_id NULL at run time — the cron
 *       scheduler dispatches `automation.workspaceId` verbatim, which the
 *       payload type under-declares as `string`) may target pod-wide channels
 *       ONLY: NULL must not mean "anything goes",
 *   (e) the id is part of the predicate — a right-workspace/wrong-id row is not
 *       mistaken for a match.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type ChannelRow = { id: string; workspace_id: string | null };
type Node = any;

const mocks = vi.hoisted(() => ({
  /** The fixture channels table the mocked findFirst scans. */
  rows: [] as ChannelRow[],
  /** Column identity, filled from the REAL schema inside the module mock. */
  idCol: undefined as unknown,
  wsCol: undefined as unknown,
  insertChannelMessage: vi.fn(),
  ensureAutomationRunChannel: vi.fn(),
}));

/** Evaluate the tagged predicate tree the executor actually built. */
function evalNode(node: Node, row: ChannelRow): boolean {
  switch (node?._tag) {
    case "and":
      return node.parts.every((p: Node) => evalNode(p, row));
    case "or":
      return node.parts.some((p: Node) => evalNode(p, row));
    case "eq":
      return colValue(node.col, row) === node.val;
    case "isNull":
      return colValue(node.col, row) === null;
    default:
      throw new Error(`evalNode: unhandled tag ${node?._tag}`);
  }
}

function colValue(col: unknown, row: ChannelRow): string | null {
  if (col === mocks.idCol) return row.id;
  if (col === mocks.wsCol) return row.workspace_id;
  throw new Error("predicate referenced an unexpected channels column");
}

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  mocks.idCol = actual.channels.id;
  mocks.wsCol = actual.channels.workspaceId;

  class ChannelRepository {
    constructor(_db: unknown) {}
    ensureAutomationRunChannel = mocks.ensureAutomationRunChannel;
    ensureEntityChannel = vi.fn();
    ensureUserPersonalChannel = vi.fn();
    ensureProactiveFeedChannel = vi.fn();
  }

  const db = {
    query: {
      channels: {
        findFirst: ({ where }: { where: Node }) =>
          Promise.resolve(mocks.rows.find((r) => evalNode(where, r))),
      },
    },
  };

  return {
    ...actual,
    db,
    ChannelRepository,
    insertChannelMessage: mocks.insertChannelMessage,
    // Tagged-node operators — `and`/`or` are variadic and drop undefined the
    // way drizzle does.
    and: (...parts: Node[]) => ({
      _tag: "and",
      parts: parts.filter(Boolean),
    }),
    or: (...parts: Node[]) => ({ _tag: "or", parts: parts.filter(Boolean) }),
    eq: (col: unknown, val: unknown) => ({ _tag: "eq", col, val }),
    isNull: (col: unknown) => ({ _tag: "isNull", col }),
  };
});

const { executeOutputStep } = await import("../automation-executor.js");

const OWNER = "user-owner";
const WS_OWN = "ws-own";
const WS_OTHER = "ws-other";

const automationContext = {
  automationRunId: "run-1",
  automationId: "auto-1",
  chainDepth: 0,
  rootRunId: "run-1",
  chainAutomationIds: [] as string[],
};

const post = (channelId: string, workspaceId: string | null) =>
  executeOutputStep(
    {
      outputType: "channel_message",
      config: { channelId, content: "payload" },
    },
    {
      trigger: { payload: {} },
      steps: {},
      automation: { id: "auto-1", state: {} },
    },
    // The payload type says `string`; the cron path really can hand NULL here
    // for a pod-wide automation, which is exactly case (d).
    workspaceId as string,
    automationContext,
    OWNER,
    OWNER,
    { nodeId: "node-cm", stepRunId: "sr-1" },
    null
  );

describe("channel_message — explicit channelId scope re-validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insertChannelMessage.mockResolvedValue({});
    mocks.ensureAutomationRunChannel.mockResolvedValue({ id: "ch-run" });
    mocks.rows = [
      { id: "ch-own", workspace_id: WS_OWN },
      { id: "ch-foreign", workspace_id: WS_OTHER },
      { id: "ch-podwide", workspace_id: null },
    ];
  });

  it("(a) a channel in the automation's own workspace is reachable", async () => {
    await expect(post("ch-own", WS_OWN)).resolves.toMatchObject({
      status: "sent",
      channelId: "ch-own",
    });
    expect(mocks.insertChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "ch-own" })
    );
  });

  it("(b) a pod-wide channel is reachable from a workspace-scoped automation", async () => {
    await expect(post("ch-podwide", WS_OWN)).resolves.toMatchObject({
      status: "sent",
      channelId: "ch-podwide",
    });
  });

  it("(c) SECURITY — a channel in ANOTHER workspace is refused, and nothing is posted anywhere", async () => {
    await expect(post("ch-foreign", WS_OWN)).rejects.toThrow(
      /ch-foreign is not reachable from workspace ws-own/
    );
    expect(mocks.insertChannelMessage).not.toHaveBeenCalled();
    expect(mocks.ensureAutomationRunChannel).not.toHaveBeenCalled();
  });

  it("(d) SECURITY — a POD-WIDE automation may target pod-wide channels only", async () => {
    await expect(post("ch-podwide", null)).resolves.toMatchObject({
      status: "sent",
      channelId: "ch-podwide",
    });

    mocks.insertChannelMessage.mockClear();
    await expect(post("ch-own", null)).rejects.toThrow(
      /not reachable from this pod-wide automation/
    );
    expect(mocks.insertChannelMessage).not.toHaveBeenCalled();
  });

  it("(e) the channel id is part of the predicate — an unknown id in the right workspace is refused", async () => {
    await expect(post("ch-ghost", WS_OWN)).rejects.toThrow(
      /ch-ghost is not reachable/
    );
    expect(mocks.insertChannelMessage).not.toHaveBeenCalled();
  });
});
