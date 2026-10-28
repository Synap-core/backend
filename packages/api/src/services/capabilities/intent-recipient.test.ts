/**
 * The recipient of an intent action (CRM consolidation, Lane 2), pure: the
 * `$to.<address>` grammar, the pod's resolution of each address from the
 * recipient it read, and the words the person reviews. Each row rules out
 * one wrong implementation:
 *  - a `$to` key outside the closed address list installed anyway, or `$to`
 *    mapped for an intent whose input has no `to`;
 *  - an action that sends to someone not asking for `to`;
 *  - an address the pod does not hold mapped to `undefined` and sent anyway
 *    instead of refused with a plain `why`;
 *  - a chat or attendee id from ANOTHER account used for this one;
 *  - a LinkedIn id handed to an action on an Instagram account;
 *  - the provider id looked up by a hand-written per-provider branch rather
 *    than the `<provider>ProviderId` convention;
 *  - "last used" counting a conversation on another account, or a touch
 *    through another channel;
 *  - a review that names an id instead of the recipient and the account.
 */
import { describe, expect, it } from "vitest";
import {
  actionInputSchema,
  describeIntentRun,
  inputFieldsRead,
  inputMapProblems,
  mapIntentInput,
  readInputMap,
  recipientAddressesRead,
} from "./intent-input.js";
import {
  lastUsedWith,
  resolveRecipient,
  type IntentRecipient,
} from "./intent-recipient.js";

/** migrations/0369_intent_input_send_message.sql's send_message, verbatim. */
const SEND_MESSAGE = {
  type: "object",
  properties: {
    to: { type: "string", format: "uuid" },
    text: { type: "string", minLength: 1, maxLength: 10000 },
    subject: { type: "string", minLength: 1, maxLength: 300 },
  },
  required: ["to", "text"],
  additionalProperties: false,
};

/** A Unipile chat verb: one action per account, the chat with the person. */
const UNIPILE_REPLY = {
  params: {
    accountId: "$account.id",
    threadId: "$to.chat",
    text: "$.text",
  },
  accounts: {
    verb: "unipile_list_accounts",
    id: "id",
    label: "name",
    provider: "type",
  },
};
const GMAIL = {
  params: { to: "$to.email", subject: "$.subject", body: "$.text" },
};

const LINKEDIN = {
  id: "acc-li",
  label: "Antoine Servant",
  provider: "LINKEDIN",
};
const INSTAGRAM = {
  id: "acc-ig",
  label: "antoiinesrvt",
  provider: "INSTAGRAM",
};

const MARIE: IntentRecipient = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Marie Dupont",
  properties: {
    email: "marie@example.test",
    linkedinUrl: "https://www.linkedin.com/in/marie-dupont/",
    linkedinProviderId: "ACoAAMarie",
  },
  conversations: [
    {
      provider: "linkedin",
      accountId: "acc-li",
      chatId: "chat-li-new",
      participantId: null,
      at: 3_000,
    },
    {
      provider: "linkedin",
      accountId: "acc-li",
      chatId: "chat-li-old",
      participantId: null,
      at: 1_000,
    },
    {
      provider: "instagram",
      accountId: "acc-ig",
      chatId: "chat-ig",
      participantId: "ig-marie",
      at: 2_000,
    },
  ],
  touches: [{ channel: "email", at: 5_000 }],
};

describe("the $to grammar — validated on install", () => {
  it("accepts every address of the closed list", () => {
    expect(
      inputMapProblems(
        {
          params: {
            a: "$to.email",
            b: "$to.phone",
            c: "$to.linkedin.providerId",
            d: "$to.linkedin.publicIdentifier",
            e: "$to.chat",
            f: "$to.attendee",
          },
        },
        { intent: "send_message", inputFields: ["to", "text"] }
      )
    ).toEqual([]);
  });

  it.each(["$to.fax", "$to.linkedin", "$to.email.domain", "$to.linkedin.url"])(
    "refuses %s (not an address the pod resolves)",
    (source) => {
      expect(
        inputMapProblems(
          { params: { x: source } },
          { intent: "send_message", inputFields: ["to", "text"] }
        )
      ).toEqual([expect.stringContaining("a recipient has only")]);
    }
  );

  it("refuses $to for an intent whose input names no recipient", () => {
    expect(
      inputMapProblems(
        { params: { x: "$to.email" } },
        { intent: "publish_post", inputFields: ["text", "when"] }
      )
    ).toEqual([expect.stringContaining('a field "to"')]);
  });

  it("a stored map with $to reads back", () => {
    expect(readInputMap(GMAIL)).toEqual(GMAIL);
  });
});

describe("an action that sends to someone asks for `to`", () => {
  it("reads `to` (never the address) and requires it", () => {
    expect(inputFieldsRead(GMAIL).sort()).toEqual(["subject", "text", "to"]);
    expect(recipientAddressesRead(GMAIL)).toEqual(["email"]);
    const schema = actionInputSchema(SEND_MESSAGE, GMAIL) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "subject",
      "text",
      "to",
    ]);
    expect(schema.required.sort()).toEqual(["text", "to"]);
  });

  it("maps each $to path from the addresses the pod resolved, never from the input", () => {
    expect(
      mapIntentInput(
        UNIPILE_REPLY,
        { to: MARIE.id, text: "Hi", chat: "forged" },
        LINKEDIN,
        { chat: "chat-li-new" }
      )
    ).toEqual({ accountId: "acc-li", threadId: "chat-li-new", text: "Hi" });
  });
});

describe("resolveRecipient — the pod finds the address for one account", () => {
  it("email and the LinkedIn ids come from the entity's properties", () => {
    expect(
      resolveRecipient(
        MARIE,
        ["email", "linkedin.providerId", "linkedin.publicIdentifier"],
        { account: null, provider: null }
      )
    ).toEqual({
      ok: true,
      addresses: {
        email: "marie@example.test",
        "linkedin.providerId": "ACoAAMarie",
        "linkedin.publicIdentifier": "marie-dupont",
      },
    });
  });

  it("the chat is the newest one on THIS account, never another's", () => {
    expect(
      resolveRecipient(MARIE, ["chat"], { account: LINKEDIN, provider: null })
    ).toEqual({ ok: true, addresses: { chat: "chat-li-new" } });
    expect(
      resolveRecipient(MARIE, ["chat"], { account: INSTAGRAM, provider: null })
    ).toEqual({ ok: true, addresses: { chat: "chat-ig" } });
    expect(
      resolveRecipient(MARIE, ["chat"], {
        account: { id: "acc-wa", label: "+33 6", provider: "WHATSAPP" },
        provider: null,
      })
    ).toEqual({
      ok: false,
      why: "No conversation with Marie Dupont on +33 6 yet.",
    });
  });

  it("the attendee is the chat's participant on this account, else <provider>ProviderId", () => {
    expect(
      resolveRecipient(MARIE, ["attendee"], {
        account: INSTAGRAM,
        provider: null,
      })
    ).toEqual({ ok: true, addresses: { attendee: "ig-marie" } });
    expect(
      resolveRecipient(MARIE, ["attendee"], {
        account: LINKEDIN,
        provider: null,
      })
    ).toEqual({ ok: true, addresses: { attendee: "ACoAAMarie" } });
    expect(
      resolveRecipient({ ...MARIE, conversations: [] }, ["attendee"], {
        account: INSTAGRAM,
        provider: null,
      })
    ).toEqual({ ok: false, why: "No Instagram id on file for Marie Dupont." });
  });

  it("a LinkedIn address serves only an action on a LinkedIn account", () => {
    const ids = ["linkedin.providerId"] as const;
    expect(
      resolveRecipient(MARIE, ids, { account: INSTAGRAM, provider: null })
    ).toEqual({
      ok: false,
      why: "Instagram can't reach Marie Dupont on LinkedIn.",
    });
    expect(
      resolveRecipient(MARIE, ["linkedin.publicIdentifier"], {
        account: { id: "acc-x", label: "Inbox", provider: null },
        provider: "linkedin",
      })
    ).toEqual({
      ok: false,
      why: "Inbox can't reach Marie Dupont on LinkedIn.",
    });
    // Unipile names the provider in capitals.
    expect(
      resolveRecipient(MARIE, ids, { account: LINKEDIN, provider: null })
    ).toEqual({ ok: true, addresses: { "linkedin.providerId": "ACoAAMarie" } });
    // An action with no account reads the person's properties.
    expect(
      resolveRecipient(MARIE, ids, { account: null, provider: "unipile" })
    ).toEqual({ ok: true, addresses: { "linkedin.providerId": "ACoAAMarie" } });
  });

  it("email and phone serve an action on any account", () => {
    expect(
      resolveRecipient(MARIE, ["email"], { account: INSTAGRAM, provider: null })
    ).toEqual({ ok: true, addresses: { email: "marie@example.test" } });
  });

  it("an address the pod does not hold is refused in one plain sentence", () => {
    const bare: IntentRecipient = {
      ...MARIE,
      name: "Paul",
      properties: { email: "not-an-address" },
      conversations: [],
    };
    expect(
      resolveRecipient(bare, ["email"], { account: null, provider: "gmail" })
    ).toEqual({ ok: false, why: "No email on file for Paul." });
    expect(
      resolveRecipient(bare, ["linkedin.providerId"], {
        account: null,
        provider: null,
      })
    ).toEqual({ ok: false, why: "No LinkedIn id on file for Paul." });
  });
});

describe("lastUsedWith — the channel last used with them", () => {
  it("a conversation counts only on the action's own account", () => {
    expect(
      lastUsedWith(MARIE, ["chat"], { account: LINKEDIN, provider: null })
    ).toBe(3_000);
    expect(
      lastUsedWith(MARIE, ["chat"], { account: INSTAGRAM, provider: null })
    ).toBe(2_000);
  });

  it("a sent touch counts through its channel: the provider or an address the map reads", () => {
    expect(
      lastUsedWith(MARIE, ["email"], { account: null, provider: "gmail" })
    ).toBe(5_000);
    expect(
      lastUsedWith(MARIE, ["linkedin.providerId"], {
        account: { id: "acc-other", label: "x", provider: "LINKEDIN" },
        provider: null,
      })
    ).toBeNull();
  });
});

describe("describeIntentRun — what the person reviews", () => {
  it("names the recipient and the account, never an id", () => {
    expect(
      describeIntentRun({
        label: "Send message",
        account: LINKEDIN,
        recipient: { name: "Marie Dupont" },
      })
    ).toBe("Send message to Marie Dupont from Antoine Servant on LinkedIn");
  });

  it("does not repeat a provider the words already name", () => {
    expect(
      describeIntentRun({
        label: "Schedule a post",
        account: {
          id: "int-li",
          label: "LinkedIn (Antoine)",
          provider: "linkedin",
        },
      })
    ).toBe("Schedule a post from LinkedIn (Antoine)");
  });
});
