import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  scoreTextMatch,
  deriveBuiltinVerbParamsSchema,
  deriveProviderVerbParamsSchema,
  buildVerbStates,
  indexContainerLinks,
  containerMemberKey,
  loadContainerRefs,
} from "./capability-registry.js";
import type { ProviderVerbSpec } from "@synap/database/schema";

// ── db harness for the batched container fan-out ─────────────────────────────
// `loadContainerRefs` is the ONE query that resolves brick → container. The
// harness records every `select()` so "batched" can be asserted as a FACT (one
// query for N bricks) rather than inferred from the returned mapping, and keeps
// the composed WHERE so the predicate itself is assertable.
interface DbHarness {
  rows: Array<{
    fromType: string;
    fromId: string;
    containerId: string;
    containerName: string | null;
  }>;
  selectCalls: number;
  fromTables: unknown[];
  wheres: unknown[];
}
let harness: DbHarness;

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    select: () => {
      harness.selectCalls += 1;
      return chain;
    },
    from: (t: unknown) => {
      harness.fromTables.push(t);
      return chain;
    },
    leftJoin: () => chain,
    where: (w: unknown) => {
      harness.wheres.push(w);
      return chain;
    },
    orderBy: () => Promise.resolve(harness.rows),
  };
  return { ...actual, getDb: async () => chain };
});

/** Every string literal bound into a drizzle SQL tree (params + raw values). */
function collectSqlValues(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (typeof node === "string") return out;
  if (Array.isArray(node)) {
    for (const n of node) collectSqlValues(n, out);
    return out;
  }
  if (typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if ("value" in rec) {
      const v = rec.value;
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) {
        for (const x of v) if (typeof x === "string") out.push(x);
      }
    }
    for (const [k, v] of Object.entries(rec)) {
      if (k === "table" || k === "_") continue;
      if (typeof v === "object") collectSqlValues(v, out);
    }
    return out;
  }
  return out;
}

/**
 * Container membership is what makes "packaged capability" vs "loose brick"
 * computable at this door: before it, `integrations[]` carried no id and no
 * container reference at all, so a consumer had to group by NAME.
 */
describe("indexContainerLinks", () => {
  it("maps a member to its container, keyed by endpoint TYPE + id", () => {
    const idx = indexContainerLinks([
      {
        fromType: "tool",
        fromId: "t1",
        containerId: "c1",
        containerName: "Gmail",
      },
      {
        fromType: "skill",
        fromId: "s1",
        containerId: "c2",
        containerName: "Research",
      },
    ]);
    expect(idx.get(containerMemberKey("tool", "t1"))).toEqual({
      id: "c1",
      name: "Gmail",
    });
    expect(idx.get(containerMemberKey("skill", "s1"))).toEqual({
      id: "c2",
      name: "Research",
    });
  });

  it("does not collide a tool and a skill that share an id", () => {
    const idx = indexContainerLinks([
      {
        fromType: "tool",
        fromId: "same",
        containerId: "c-tool",
        containerName: "T",
      },
      {
        fromType: "skill",
        fromId: "same",
        containerId: "c-skill",
        containerName: "S",
      },
    ]);
    expect(idx.get(containerMemberKey("tool", "same"))?.id).toBe("c-tool");
    expect(idx.get(containerMemberKey("skill", "same"))?.id).toBe("c-skill");
  });

  it("keeps the FIRST (oldest, caller-ordered) edge when a brick has several", () => {
    const idx = indexContainerLinks([
      {
        fromType: "tool",
        fromId: "t1",
        containerId: "oldest",
        containerName: "A",
      },
      {
        fromType: "tool",
        fromId: "t1",
        containerId: "newer",
        containerName: "B",
      },
    ]);
    expect(idx.get(containerMemberKey("tool", "t1"))?.id).toBe("oldest");
  });

  it("reports a dangling container name as null rather than fabricating one", () => {
    const idx = indexContainerLinks([
      {
        fromType: "tool",
        fromId: "t1",
        containerId: "c1",
        containerName: null,
      },
    ]);
    expect(idx.get(containerMemberKey("tool", "t1"))).toEqual({
      id: "c1",
      name: null,
    });
  });

  it("returns no entry for a brick in no container (the caller reads null)", () => {
    const idx = indexContainerLinks([]);
    expect(idx.get(containerMemberKey("tool", "t1"))).toBeUndefined();
  });
});

describe("loadContainerRefs — batched fan-out", () => {
  beforeEach(() => {
    harness = { rows: [], selectCalls: 0, fromTables: [], wheres: [] };
  });

  it("resolves N bricks with ONE query, not one per brick", async () => {
    harness.rows = [
      {
        fromType: "tool",
        fromId: "t1",
        containerId: "c1",
        containerName: "Gmail",
      },
      {
        fromType: "skill",
        fromId: "s2",
        containerId: "c1",
        containerName: "Gmail",
      },
    ];
    const idx = await loadContainerRefs({
      toolIds: ["t1", "t2", "t3"],
      skillIds: ["s1", "s2"],
    });
    // 5 bricks, 1 query — a per-brick lookup would be 5.
    expect(harness.selectCalls).toBe(1);
    expect(idx.get(containerMemberKey("tool", "t1"))?.id).toBe("c1");
    // A brick with no edge is simply absent → the caller reports null.
    expect(idx.get(containerMemberKey("tool", "t2"))).toBeUndefined();
    expect(idx.get(containerMemberKey("skill", "s1"))).toBeUndefined();
  });

  it("issues NO query at all when there is nothing to resolve", async () => {
    const idx = await loadContainerRefs({ toolIds: [], skillIds: [] });
    expect(harness.selectCalls).toBe(0);
    expect(idx.size).toBe(0);
  });

  /**
   * Shape, not just count: the fan-out must reuse the SAME predicate as
   * `resolveToolCapabilityId` — `member_of` edges from tool/skill endpoints to
   * a `capability` — over ALL the ids in one `inArray`. Asserting the composed
   * WHERE is what makes a broken predicate fail here instead of silently
   * returning an empty index in production.
   */
  it("composes the member_of → capability predicate over every id at once", async () => {
    await loadContainerRefs({ toolIds: ["t1", "t2"], skillIds: ["s1"] });
    const values = collectSqlValues(harness.wheres[0]);
    expect(values).toContain("member_of");
    expect(values).toContain("capability");
    expect(values).toEqual(expect.arrayContaining(["tool", "skill"]));
    expect(values).toEqual(expect.arrayContaining(["t1", "t2", "s1"]));
  });
});

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

  it("extracts {{param}} tokens from a GraphQL verb's query text AND variables", () => {
    const spec: ProviderVerbSpec = {
      tool: "fireflies",
      method: "POST",
      pathTemplate: "/graphql",
      transport: "graphql",
      graphql: {
        // one token in the query string, one in variables
        query: 'query { thing(id: "{{id}}") { x } }',
        variables: { keyword: "{{query}}" },
        operation: "query",
      },
      paramMapping: { id: { required: true } },
    };
    const schema = deriveProviderVerbParamsSchema(spec);
    expect(schema).toEqual({
      id: { required: true },
      query: { required: false },
    });
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
