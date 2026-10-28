/**
 * One input per intent (decision 5B, 2026-10-28): the mapping language and
 * the input checks, pure. Each row rules out one wrong implementation:
 *  - an expression or a bare literal string accepted as a source;
 *  - a map naming a parameter the verb does not declare, or an input field the
 *    intent does not have, installed anyway;
 *  - an absent input field mapped to `undefined` (overriding the verb's own
 *    default) instead of left out;
 *  - an action advertising a field its verb drops;
 *  - the intent's limits (required text, 3000 chars, https link, date-time)
 *    not enforced;
 *  - an account source that is not a read of the same tool, or names a field
 *    its verb does not list, installed anyway; `$account` read with no source;
 *  - an account with no id or label offered (it cannot be targeted or named).
 */
import { describe, expect, it } from "vitest";
import {
  accountsFromRecords,
  actionInputSchema,
  definitionInputMapProblems,
  inputFieldsRead,
  inputMapProblems,
  mapIntentInput,
  readInputMap,
  validateInput,
} from "./intent-input.js";

/** migrations/0368_intent_input_schema.sql, verbatim. */
const PUBLISH_POST = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1, maxLength: 3000 },
    media: {
      type: "array",
      items: { type: "string", format: "uuid" },
      maxItems: 10,
    },
    link: {
      type: "string",
      format: "uri",
      pattern: "^https://",
      maxLength: 2048,
    },
    when: { type: "string", format: "date-time" },
  },
  required: ["text"],
  additionalProperties: false,
};

const POSTIZ_SCHEDULE = {
  params: {
    content: "$.text",
    date: "$.when",
    type: { const: "schedule" },
  },
};

/** The Postiz shape: one key, several channels, listed by a read verb. */
const POSTIZ_ACCOUNTS = {
  params: {
    content: "$.text",
    date: "$.when",
    integrationId: "$account.id",
    provider: "$account.provider",
  },
  accounts: {
    verb: "postiz_list_integrations",
    id: "id",
    label: "name",
    provider: "provider",
  },
};

describe("inputMapProblems — validated on install", () => {
  const ok = {
    intent: "publish_post",
    inputFields: Object.keys(PUBLISH_POST.properties),
    verbParams: ["content", "date", "type", "integrationId", "provider"],
  };

  it("accepts path copies and constants", () => {
    expect(inputMapProblems(POSTIZ_SCHEDULE, ok)).toEqual([]);
  });

  it("accepts an account source and $account paths", () => {
    expect(
      inputMapProblems(POSTIZ_ACCOUNTS, {
        ...ok,
        accountVerb: {
          readOnly: true,
          sameTool: true,
          fields: ["id", "name", "provider"],
        },
      })
    ).toEqual([]);
  });

  it.each([
    [
      { params: { content: "text" } },
      'use "$.<input field>", "$account.<field>"',
    ],
    [
      { params: { content: "$.text + '!'" } },
      'use "$.<input field>", "$account.<field>"',
    ],
    [
      { params: { content: "${text}" } },
      'use "$.<input field>", "$account.<field>"',
    ],
    [
      { params: { content: { const: 1, extra: 2 } } },
      'use "$.<input field>", "$account.<field>"',
    ],
    [{ params: { content: "$.body" } }, 'no field "body"'],
    [{ params: { caption: "$.text" } }, 'no parameter "caption"'],
    [{ params: {} }, "empty"],
    [
      { params: { content: "$.text" }, extra: {} },
      "not part of the mapping language",
    ],
    [{ params: { content: "$account.id" } }, "needs inputMap.accounts"],
    [{ params: { content: "$account.secret" } }, "an account has only"],
    [{ params: { content: "$account.id.x" } }, "an account has only"],
    [
      {
        params: { provider: "$account.provider" },
        accounts: { verb: "v", id: "id", label: "name" },
      },
      "names no provider",
    ],
    [
      { params: { content: "$.text" }, accounts: { verb: "v" } },
      "accounts.id must name",
    ],
    [
      {
        params: { content: "$.text" },
        accounts: { verb: "v", id: "id", label: "name", url: "u" },
      },
      "accounts.url is not part",
    ],
    [{ content: "$.text" }, '{ "params"'],
  ])("refuses %j", (map, problem) => {
    expect(inputMapProblems(map, ok).join(" | ")).toContain(problem);
  });

  it("refuses a map on a verb that declares no intent", () => {
    expect(
      inputMapProblems(POSTIZ_SCHEDULE, { ...ok, intent: null }).join()
    ).toContain("declare an intent");
  });
});

describe("mapIntentInput — path copy and constants", () => {
  it("copies each path and writes each constant", () => {
    expect(
      mapIntentInput(POSTIZ_SCHEDULE, {
        text: "Hello",
        when: "2026-11-02T09:00:00.000Z",
      })
    ).toEqual({
      content: "Hello",
      date: "2026-11-02T09:00:00.000Z",
      type: "schedule",
    });
  });

  it("leaves a parameter out when its input field is absent", () => {
    expect(mapIntentInput(POSTIZ_SCHEDULE, { text: "Hello" })).toEqual({
      content: "Hello",
      type: "schedule",
    });
  });

  it("reads a nested path", () => {
    expect(mapIntentInput({ params: { x: "$.a.b" } }, { a: { b: 1 } })).toEqual(
      { x: 1 }
    );
  });

  it("a stored map that is no longer valid is never used", () => {
    expect(readInputMap(POSTIZ_SCHEDULE)).toEqual(POSTIZ_SCHEDULE);
    expect(readInputMap({ params: { content: "text" } })).toBeNull();
    expect(readInputMap(null)).toBeNull();
  });
});

describe("actionInputSchema — the input ONE action accepts", () => {
  it("narrows to the fields the map reads", () => {
    expect(inputFieldsRead(POSTIZ_SCHEDULE).sort()).toEqual(["text", "when"]);
    const s = actionInputSchema(PUBLISH_POST, POSTIZ_SCHEDULE) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(s.properties).sort()).toEqual(["text", "when"]);
    expect(s.required).toEqual(["text"]);
  });

  it("requires a field that feeds a parameter the verb requires", () => {
    const s = actionInputSchema(PUBLISH_POST, POSTIZ_SCHEDULE, [
      "content",
      "date",
    ]) as { required: string[] };
    expect(s.required.sort()).toEqual(["text", "when"]);
  });
});

describe("validateInput — the intent's limits hold", () => {
  const action = actionInputSchema(PUBLISH_POST, POSTIZ_SCHEDULE);

  it("accepts a valid post", () => {
    expect(
      validateInput(action, { text: "Hello", when: "2026-11-02T09:00:00Z" })
    ).toMatchObject({ ok: true });
  });

  it.each([
    [{}, "text"],
    [{ text: "" }, "text"],
    [{ text: "x".repeat(3001) }, "text"],
    [{ text: "Hi", when: "next tuesday" }, "when"],
    [{ text: "Hi", link: "https://a.b" }, ""], // a field this action drops
  ])("refuses %j", (input, path) => {
    const r = validateInput(action, input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain(path);
  });

  it("refuses a link that is not https (the intent's own schema)", () => {
    expect(
      validateInput(PUBLISH_POST, { text: "Hi", link: "http://a.b" }).ok
    ).toBe(false);
    expect(
      validateInput(PUBLISH_POST, { text: "Hi", link: "https://a.b" }).ok
    ).toBe(true);
  });
});

describe("an account source — one action per account the tool reaches", () => {
  const list = {
    name: "postiz_list_integrations",
    requires: ["postiz"],
    metadata: { readOnly: true },
    providerSpec: {
      responseShape: {
        item: { id: "id", name: "name", provider: "identifier" },
      },
    },
  };
  const verb = {
    name: "postiz_schedule",
    intent: "publish_post",
    requires: ["postiz"],
    parameters: {
      content: "string",
      integrationId: "string",
      provider: "string",
      date: "string",
    },
    inputMap: POSTIZ_ACCOUNTS,
  };

  it("installs when the source is a read of the same tool listing the named fields", () => {
    expect(
      definitionInputMapProblems(verb, [verb, list], PUBLISH_POST)
    ).toEqual([]);
  });

  it.each([
    ["names no verb of the definition", [verb], "no verb"],
    [
      "names a write",
      [verb, { ...list, metadata: { verbType: "write" } }],
      "must be a read",
    ],
    [
      "names another tool's read",
      [verb, { ...list, requires: ["unipile"] }],
      "same tool",
    ],
    [
      "names a field its verb does not list",
      [
        verb,
        { ...list, providerSpec: { responseShape: { item: { id: "id" } } } },
      ],
      'lists no field "name"',
    ],
  ])("refuses a source that %s", (_why, skills, problem) => {
    expect(
      definitionInputMapProblems(verb, skills as never, PUBLISH_POST).join(
        " | "
      )
    ).toContain(problem);
  });

  it("refuses any map while the intent declares no input", () => {
    expect(
      definitionInputMapProblems(verb, [verb, list], null).join()
    ).toContain("declares no input shape");
  });

  it("reads each listed record as an account; one with no id or label is skipped", () => {
    expect(
      accountsFromRecords(POSTIZ_ACCOUNTS.accounts, [
        { id: "i1", name: "LinkedIn (Antoine)", provider: "linkedin" },
        { id: "i2", name: "  ", provider: "x" },
        { name: "No id", provider: "x" },
        { id: "i1", name: "Duplicate", provider: "linkedin" },
        { id: 7, name: "Bluesky", provider: null },
        "not a record",
      ])
    ).toEqual([
      { id: "i1", label: "LinkedIn (Antoine)", provider: "linkedin" },
      { id: "7", label: "Bluesky", provider: null },
    ]);
  });

  it("maps $account from the targeted account, and the input from the app", () => {
    expect(
      mapIntentInput(
        POSTIZ_ACCOUNTS,
        { text: "Hello", when: "2026-11-02T09:00:00Z" },
        { id: "i1", label: "LinkedIn (Antoine)", provider: "linkedin" }
      )
    ).toEqual({
      content: "Hello",
      date: "2026-11-02T09:00:00Z",
      integrationId: "i1",
      provider: "linkedin",
    });
  });

  it("an action's input never lists the account fields (the pod fills them)", () => {
    const s = actionInputSchema(PUBLISH_POST, POSTIZ_ACCOUNTS, [
      "content",
      "integrationId",
      "provider",
      "date",
    ]) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(s.properties).sort()).toEqual(["text", "when"]);
    expect(s.required.sort()).toEqual(["text", "when"]);
  });

  it("a stored map with an account source reads back; a broken one never does", () => {
    expect(readInputMap(POSTIZ_ACCOUNTS)).toEqual(POSTIZ_ACCOUNTS);
    expect(
      readInputMap({ params: { integrationId: "$account.id" } })
    ).toBeNull();
  });
});
