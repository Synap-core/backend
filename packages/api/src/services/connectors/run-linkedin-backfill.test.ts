/**
 * The LinkedIn backfill reads Unipile v2 objects as v2 shapes them: a 1to1
 * chat names the other person in `user`, a message names its sender in
 * `sender` (a User). v2 has no `attendees`, no `sender_name`.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * 2026-10-28: the extraction read v1 fields (`attendees[0].name`,
 * `sender_name`), so every v2 message was recorded with its sender's opaque
 * provider id as the participant, while the webhook path recorded the name.
 *
 * The capability verbs are stubbed with the raw v2 rows the declarative verbs
 * return (`{ conversations }`, `{ messages }`); the recorder is spied.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  recorded: [] as Array<Record<string, unknown>>,
}));

vi.mock("../capabilities/execute-capability.js", () => ({
  executeCapability: vi.fn(async ({ verbId }: { verbId: string }) => ({
    kind: "run",
    skillId: verbId,
    result: h.results[verbId],
  })),
}));
vi.mock("./inbound-recorder.js", () => ({
  recordInboundMessage: vi.fn(async (input: Record<string, unknown>) => {
    h.recorded.push(input);
    return { recorded: true };
  }),
}));
vi.mock("../messaging-account-service.js", () => ({
  MessagingAccountService: { upsert: vi.fn(async () => undefined) },
}));

import { runLinkedInBackfill } from "./run-linkedin-backfill.js";

beforeEach(() => {
  h.recorded = [];
  h.results = {
    unipile_list_accounts: {
      accounts: [{ object: "Account", id: "acc_li", name: "Antoine Servant" }],
    },
    unipile_list_conversations: {
      conversations: [
        {
          object: "Chat",
          id: "chat-1",
          name: "Ada Lovelace",
          user: { object: "User", id: "li-ada", display_name: "Ada Lovelace" },
        },
      ],
    },
    unipile_list_messages: {
      messages: [
        {
          object: "Message",
          id: "m1",
          chat_id: "chat-1",
          sender_id: "li-ada",
          sender: {
            object: "User",
            id: "li-ada",
            display_name: "Ada Lovelace",
          },
          text: "Hello",
          timestamp: "2026-10-27T10:00:00.000Z",
          is_sender: false,
        },
      ],
    },
  };
});

describe("runLinkedInBackfill — v2 chat and message shapes", () => {
  it("records the sender's display name, never the provider id", async () => {
    const out = await runLinkedInBackfill({
      accountId: "acc_li",
      userId: "owner",
      workspaceId: "ws-1",
    });
    expect(out).toEqual({ threadsSeen: 1, messagesRecorded: 1 });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      provider: "linkedin",
      externalId: "chat-1",
      participant: "Ada Lovelace",
      title: "Ada Lovelace",
      text: "Hello",
      idempotencySeed: "chat-1:2026-10-27T10:00:00.000Z:Hello",
    });
  });

  it("the thread is titled by the chat's `user` (no chat name); a sender-less message keeps its id", async () => {
    const msgs = h.results.unipile_list_messages as {
      messages: Array<Record<string, unknown>>;
    };
    delete msgs.messages[0]!.sender;
    const convs = h.results.unipile_list_conversations as {
      conversations: Array<Record<string, unknown>>;
    };
    delete convs.conversations[0]!.name;
    await runLinkedInBackfill({
      accountId: "acc_li",
      userId: "owner",
      workspaceId: "ws-1",
    });
    // sender_id still names the message; the chat's `user` titles the thread.
    expect(h.recorded[0]).toMatchObject({
      participant: "li-ada",
      title: "Ada Lovelace",
    });
  });
});
