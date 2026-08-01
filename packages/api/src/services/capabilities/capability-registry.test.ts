import { describe, expect, it } from "vitest";
import {
  scoreTextMatch,
  deriveBuiltinVerbParamsSchema,
  deriveProviderVerbParamsSchema,
  buildVerbStates,
  sectionCapabilities,
  type RegistryCapability,
} from "./capability-registry.js";
import type { ProviderVerbSpec } from "@synap/database/schema";
import type { CapabilityVerbState } from "@synap/playbooks";

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

/**
 * Built-ins as BRICKS, not as a number.
 *
 * `sectionCapabilities` used to drop every `builtin-tool` row and only report
 * `excluded.builtinTools`. A count cannot render a collapsed, browsable section,
 * so built-ins are now real rows — and each carries `runnableHere`, the fact a
 * flow-node picker filters on so a catalog-only brick can never be offered as a
 * step. Teaching docs stay excluded (prompt prose is not a capability).
 */
describe("sectionCapabilities — the built-ins section", () => {
  function verb(id: string, granted = false): CapabilityVerbState {
    return {
      id,
      name: id,
      kind: "action",
      granted,
      effectiveExecMode: "propose",
    } as unknown as CapabilityVerbState;
  }

  function cap(
    partial: Partial<RegistryCapability> & {
      kind: RegistryCapability["kind"];
      name: string;
    }
  ): RegistryCapability {
    return {
      id: partial.id ?? `id-${partial.name}`,
      inputSchema: {},
      executor: "is-agent",
      governance: "propose",
      ...partial,
    } as RegistryCapability;
  }

  it("returns built-ins as rows instead of dropping them", () => {
    const out = sectionCapabilities([
      cap({ kind: "builtin-tool", name: "web_search", catalogOnly: true }),
      cap({ kind: "builtin-tool", name: "graph_traverse", catalogOnly: true }),
      cap({ kind: "command", name: "digest" }),
    ]);
    expect(out.builtins.map((b) => b.name)).toEqual([
      "web_search",
      "graph_traverse",
    ]);
    // Still not smuggled into the actionable sections.
    expect(out.integrations).toHaveLength(0);
    expect(out.skills).toHaveLength(0);
    expect(out.commands.map((c) => c.name)).toEqual(["digest"]);
  });

  it("keeps teaching docs excluded and no longer counts built-ins as excluded", () => {
    const out = sectionCapabilities([
      cap({ kind: "builtin-tool", name: "web_search", catalogOnly: true }),
      cap({ kind: "teaching-doc", name: "how-to-x", governance: "none" }),
      cap({ kind: "teaching-doc", name: "how-to-y", governance: "none" }),
    ]);
    expect(out.excluded).toEqual({ teachingDocs: 2 });
    // The lie the old shape would have told: a shown row reported as excluded.
    expect(out.excluded).not.toHaveProperty("builtinTools");
    expect(out.builtins).toHaveLength(1);
  });

  it("marks a catalogOnly built-in as NOT runnable through this door", () => {
    const out = sectionCapabilities([
      cap({ kind: "builtin-tool", name: "web_search", catalogOnly: true }),
    ]);
    expect(out.builtins[0]!.runnableHere).toBe(false);
  });

  it("derives runnableHere from the row, not from the kind", () => {
    // A `tools.kind='builtin'` row carries a verb catalog and NO catalogOnly
    // flag — hardcoding false for every built-in would assert a falsehood here.
    const out = sectionCapabilities([
      cap({
        kind: "builtin-tool",
        name: "synap_core",
        verbs: [verb("feed.post")],
      }),
    ]);
    expect(out.builtins[0]!.runnableHere).toBe(true);
    expect(out.builtins[0]!.verbs.map((v) => v.id)).toEqual(["feed.post"]);
  });

  it("dedups a built-in described twice: unions verbs, never downgrades runnableHere", () => {
    const out = sectionCapabilities([
      cap({
        kind: "builtin-tool",
        name: "synap_core",
        description: null,
        verbs: [verb("feed.post")],
      }),
      cap({
        kind: "builtin-tool",
        name: "synap_core",
        description: "Tier-0 builtin verbs",
        catalogOnly: true,
        verbs: [verb("channel.create")],
      }),
    ]);
    expect(out.builtins).toHaveLength(1);
    const core = out.builtins[0]!;
    expect(new Set(core.verbs.map((v) => v.id))).toEqual(
      new Set(["feed.post", "channel.create"])
    );
    expect(core.runnableHere).toBe(true); // the launchable copy wins
    expect(core.description).toBe("Tier-0 builtin verbs");
  });

  it("counts consistently: every input row lands in exactly one bucket", () => {
    const caps = [
      cap({ kind: "builtin-tool", name: "web_search", catalogOnly: true }),
      cap({ kind: "builtin-tool", name: "graph_traverse", catalogOnly: true }),
      cap({ kind: "teaching-doc", name: "how-to-x", governance: "none" }),
      cap({ kind: "tool", name: "exa_api", verbs: [verb("exa_search")] }),
      cap({ kind: "skill", name: "ingest_message", runnable: true }),
      cap({ kind: "command", name: "digest" }),
    ];
    const out = sectionCapabilities(caps);
    const shown =
      out.integrations.length +
      out.skills.length +
      out.commands.length +
      out.builtins.length;
    expect(shown + out.excluded.teachingDocs).toBe(caps.length);
  });
});
