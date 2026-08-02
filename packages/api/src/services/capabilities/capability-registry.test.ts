import { describe, expect, it } from "vitest";
import {
  scoreTextMatch,
  deriveBuiltinVerbParamsSchema,
  deriveProviderVerbParamsSchema,
  buildVerbStates,
} from "./capability-registry.js";
import type { ProviderVerbSpec } from "@synap/database/schema";

describe("scoreTextMatch", () => {
  it("scores an exact primary match highest", () => {
    const exact = scoreTextMatch("gmail_send", { primary: "gmail_send" });
    const partial = scoreTextMatch("gmail", { primary: "gmail_send" });
    expect(exact).toBeGreaterThan(partial);
  });

  it("matches on secondary (verb labels) and tertiary (description) fields", () => {
    const bySecondary = scoreTextMatch("send", {
      primary: "Gmail",
      secondary: ["gmail_send"],
    });
    const byTertiary = scoreTextMatch("email", {
      primary: "Gmail",
      tertiary: "Send an email via the connected account",
    });
    expect(bySecondary).toBeGreaterThan(0);
    expect(byTertiary).toBeGreaterThan(0);
  });

  it("returns 0 when no token matches anything", () => {
    expect(
      scoreTextMatch("nonexistent", {
        primary: "Gmail",
        secondary: ["gmail_send"],
        tertiary: "Send email",
      })
    ).toBe(0);
  });

  it("returns 0 for an empty/whitespace query", () => {
    expect(scoreTextMatch("   ", { primary: "Gmail" })).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(scoreTextMatch("GMAIL", { primary: "gmail_send" })).toBeGreaterThan(
      0
    );
  });
});

describe("deriveBuiltinVerbParamsSchema", () => {
  it("derives required/description from a real BUILTIN_VERB_PARAM_SCHEMAS entry", () => {
    const schema = deriveBuiltinVerbParamsSchema("feed.post");
    expect(schema).toBeDefined();
    // feed.post's Zod schema requires channelId + content, content optional.
    expect(schema?.channelId.required).toBe(true);
    expect(schema?.content.required).toBe(true);
    expect(schema?.metadata.required).toBe(false);
  });

  it("returns undefined for a verb with no registered schema", () => {
    expect(deriveBuiltinVerbParamsSchema("not.a.real.verb")).toBeUndefined();
  });
});

describe("deriveProviderVerbParamsSchema", () => {
  it("extracts {{param}} tokens from path/query/body and marks required from paramMapping", () => {
    const spec: ProviderVerbSpec = {
      tool: "gmail",
      method: "POST",
      pathTemplate: "/messages/{{messageId}}/send",
      query: { threadId: "{{threadId}}" },
      body: { to: "{{to}}" },
      paramMapping: {
        messageId: { required: true },
        to: { required: true },
        // threadId intentionally has no paramMapping entry → not required.
      },
    };
    const schema = deriveProviderVerbParamsSchema(spec);
    expect(schema).toEqual({
      messageId: { required: true },
      threadId: { required: false },
      to: { required: true },
    });
  });

  it("returns undefined when the spec references no templated params", () => {
    const spec: ProviderVerbSpec = {
      tool: "gmail",
      method: "GET",
      pathTemplate: "/messages",
    };
    expect(deriveProviderVerbParamsSchema(spec)).toBeUndefined();
  });
});

/**
 * `buildVerbStates` is where a verb's OUTPUT contract gets projected: a
 * declarative provider verb's `responseShape` lives on the backing skill's
 * `providerSpec` and is applied at execute time by `execute-provider-verb.ts`,
 * but was never surfaced in the read-model — so a brick could say what it takes
 * and not what it returns.
 */
describe("buildVerbStates — responseShape projection", () => {
  const catalog = [
    { id: "linear_list_issues", label: "List issues", govDefault: "propose" },
  ] as unknown as Parameters<typeof buildVerbStates>[0];

  const specWithShape: ProviderVerbSpec = {
    tool: "linear",
    method: "GET",
    pathTemplate: "/issues",
    responseShape: { collectionPath: "data.issues", item: { title: "title" } },
  };

  it("projects the backing declarative spec's responseShape onto a provider verb", () => {
    const [verb] = buildVerbStates(
      catalog,
      undefined,
      "provider",
      new Map([["linear_list_issues", specWithShape]]),
      new Map()
    );
    expect(verb.responseShape).toEqual({
      collectionPath: "data.issues",
      item: { title: "title" },
    });
  });

  it("omits responseShape when the spec declares none", () => {
    const [verb] = buildVerbStates(
      catalog,
      undefined,
      "provider",
      new Map([
        [
          "linear_list_issues",
          {
            tool: "linear",
            method: "GET",
            pathTemplate: "/issues",
          } as ProviderVerbSpec,
        ],
      ]),
      new Map()
    );
    expect(verb.responseShape).toBeUndefined();
    expect("responseShape" in verb).toBe(false);
  });

  it("omits responseShape when no backing spec exists for the verb", () => {
    const [verb] = buildVerbStates(
      catalog,
      undefined,
      "provider",
      new Map(),
      new Map()
    );
    expect(verb.responseShape).toBeUndefined();
  });

  it("does not project responseShape onto a BUILTIN verb (no provider spec applies)", () => {
    const [verb] = buildVerbStates(
      catalog,
      undefined,
      "builtin",
      new Map([["linear_list_issues", specWithShape]]),
      new Map()
    );
    expect(verb.responseShape).toBeUndefined();
  });

  it("still derives paramsSchema for a provider verb (the refactor kept it)", () => {
    const [verb] = buildVerbStates(
      catalog,
      undefined,
      "provider",
      new Map([
        [
          "linear_list_issues",
          {
            tool: "linear",
            method: "GET",
            pathTemplate: "/issues/{{issueId}}",
            paramMapping: { issueId: { required: true } },
          } as ProviderVerbSpec,
        ],
      ]),
      new Map()
    );
    expect(verb.paramsSchema).toEqual({ issueId: { required: true } });
  });
});
