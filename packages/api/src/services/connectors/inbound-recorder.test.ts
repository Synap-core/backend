/**
 * Focused test for the keystone additive fact write: `recordInboundMessage`
 * must append a `message.received` observation to the `events` log (via
 * `emitMessageObservation`) exactly when a NEW `messages` row lands, and must
 * NOT do so on an idempotent-conflict re-delivery (the `onConflictDoNothing`
 * no-op path).
 *
 * `db` and its collaborators are mocked so this exercises `recordInboundMessage`
 * itself without a real database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  emitMessageObservation,
  emitSideEffects,
  getBossSend,
  channelsFindFirst,
  messagesFindFirst,
  insertChain,
  updateChain,
  db,
} = vi.hoisted(() => {
  const insertChain = {
    values: vi.fn(),
    onConflictDoNothing: vi.fn(),
    returning: vi.fn(),
  };
  insertChain.values.mockReturnValue(insertChain);
  insertChain.onConflictDoNothing.mockReturnValue(insertChain);

  const updateChain = {
    set: vi.fn(),
    where: vi.fn(),
  };
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockResolvedValue(undefined);

  const channelsFindFirst = vi.fn();
  const messagesFindFirst = vi.fn();

  const db = {
    query: {
      channels: { findFirst: channelsFindFirst },
      messages: { findFirst: messagesFindFirst },
    },
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
  };

  return {
    emitMessageObservation: vi.fn(),
    emitSideEffects: vi.fn().mockResolvedValue(undefined),
    getBossSend: vi.fn().mockResolvedValue(undefined),
    channelsFindFirst,
    messagesFindFirst,
    insertChain,
    updateChain,
    db,
  };
});

vi.mock("@synap/database", () => ({
  db,
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  isNotNull: vi.fn(),
  drizzleSql: vi.fn(),
  channels: {},
  messages: {},
  ChannelType: { EXTERNAL: "external" },
  ChannelScope: { WORKSPACE: "workspace", POD: "pod" },
  MessageRole: { USER: "user" },
  MessageAuthorType: { EXTERNAL: "external" },
  MessageCategory: { CHAT: "chat" },
  resolveIdentity: vi.fn(),
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: (...args: unknown[]) => emitSideEffects(...args),
  getBoss: () => ({ send: (...args: unknown[]) => getBossSend(...args) }),
}));

vi.mock("@synap/jobs/workers/inbound-attachment-worker.js", () => ({
  INBOUND_ATTACHMENT_QUEUE: "inbound-attachment",
}));

vi.mock("../external-user-mapping.js", () => ({
  resolveExistingExternalUser: vi.fn(),
}));

vi.mock("../channels/channel-origin.js", () => ({
  recordChannelOrigin: vi.fn(),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../utils/emit-message-observation.js", () => ({
  emitMessageObservation: (...args: unknown[]) =>
    emitMessageObservation(...args),
}));

import { recordInboundMessage } from "./inbound-recorder.js";

const EXISTING_CHANNEL = {
  id: "chan-1",
  userId: "user-1",
  workspaceId: null,
  contextObjectId: null,
  contextObjectType: null,
  branchPurpose: null,
};

const BASE_ARGS = {
  provider: "proton",
  externalId: "thread-1",
  userId: "user-1",
  workspaceId: null,
  text: "hello there",
  title: "Proton · alice",
  idempotencySeed: "seed-1",
  suppressSideEffects: true,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  channelsFindFirst.mockResolvedValue(EXISTING_CHANNEL);
  insertChain.values.mockReturnValue(insertChain);
  insertChain.onConflictDoNothing.mockReturnValue(insertChain);
  db.insert.mockReturnValue(insertChain);
  db.update.mockReturnValue(updateChain);
  updateChain.set.mockReturnValue(updateChain);
  updateChain.where.mockResolvedValue(undefined);
});

describe("recordInboundMessage — message.received observation", () => {
  it("appends a message.received observation when a NEW message row is inserted", async () => {
    insertChain.returning.mockResolvedValue([{ id: "msg-1" }]);

    const result = await recordInboundMessage({ ...BASE_ARGS });

    expect(result.recorded).toBe(true);
    expect(emitMessageObservation).toHaveBeenCalledTimes(1);
    expect(emitMessageObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message.received",
        channelId: "chan-1",
        messageId: "msg-1",
        userId: "user-1",
      })
    );

    // Never copies the message body into the observation's `data`.
    const call = emitMessageObservation.mock.calls[0][0];
    expect(JSON.stringify(call.data)).not.toContain("hello there");
    // Stamps the fact with a real occurrence time (backfill-replay honesty).
    expect(call.timestamp).toBeInstanceOf(Date);
    // Unbound channel → no entity label.
    expect(call.entityId).toBeUndefined();
  });

  it("labels entityId ONLY when the bound context object is an entity", async () => {
    insertChain.returning.mockResolvedValue([{ id: "msg-2" }]);
    // Channel rebound to a DOCUMENT (via channel.bind) — contextObjectId is set
    // but it is NOT an entity, so it must never be labeled `entityId`.
    channelsFindFirst.mockResolvedValue({
      ...EXISTING_CHANNEL,
      contextObjectId: "doc-1",
      contextObjectType: "document",
    });

    await recordInboundMessage({ ...BASE_ARGS });

    const call = emitMessageObservation.mock.calls[0][0];
    expect(call.entityId).toBeUndefined();
    expect(call.data.entityId).toBeUndefined();
  });

  it("passes entityId when the channel IS entity-bound", async () => {
    insertChain.returning.mockResolvedValue([{ id: "msg-3" }]);
    channelsFindFirst.mockResolvedValue({
      ...EXISTING_CHANNEL,
      contextObjectId: "ent-1",
      contextObjectType: "entity",
    });

    await recordInboundMessage({ ...BASE_ARGS });

    const call = emitMessageObservation.mock.calls[0][0];
    expect(call.entityId).toBe("ent-1");
  });

  it("does NOT append an observation on an idempotent-conflict re-delivery", async () => {
    // onConflictDoNothing no-op → empty `.returning()` result.
    insertChain.returning.mockResolvedValue([]);
    // Re-SELECT of the surviving row (existing insert already claimed the hash).
    messagesFindFirst.mockResolvedValue({ id: "msg-1" });

    const result = await recordInboundMessage({ ...BASE_ARGS });

    expect(result.recorded).toBe(false);
    expect(emitMessageObservation).not.toHaveBeenCalled();
  });
});
