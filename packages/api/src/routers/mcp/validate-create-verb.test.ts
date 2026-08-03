/**
 * validateCreateVerbInput — unit tests for the synap_create_verb hard safety
 * constraints. No DB/network involved: this is pure input validation.
 */

import { describe, it, expect } from "vitest";
import { validateCreateVerbInput } from "./validate-create-verb.js";

const VALID_ARGS = {
  toolName: "apify_api",
  verbName: "apify_search_reddit_actors",
  description: "Search the Apify actor marketplace for Reddit scrapers.",
  method: "GET",
  pathTemplate: "/v2/acts?search={{query}}",
  parameters: { query: "string" },
};

describe("validateCreateVerbInput", () => {
  it("accepts a well-formed declarative verb request", () => {
    const result = validateCreateVerbInput(VALID_ARGS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.toolName).toBe("apify_api");
      expect(result.data.method).toBe("GET");
    }
  });

  // ── Hard constraint 1: declarative only ──────────────────────────────────
  it.each(["code", "instruction", "builtin"])(
    "rejects an explicit kind='%s'",
    (kind) => {
      const result = validateCreateVerbInput({ ...VALID_ARGS, kind });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/only creates declarative verbs/i);
      }
    }
  );

  it("accepts an explicit kind='declarative' (redundant but not rejected)", () => {
    const result = validateCreateVerbInput({
      ...VALID_ARGS,
      kind: "declarative",
    });
    expect(result.ok).toBe(true);
  });

  // ── Hard constraint 2: never accept executable code ──────────────────────
  it("rejects a request carrying a top-level `code` field", () => {
    const result = validateCreateVerbInput({
      ...VALID_ARGS,
      code: "process.exit(1)",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/never accepts executable code/i);
    }
  });

  it("rejects code even when kind is not set (can't sneak code in via a bare field)", () => {
    const result = validateCreateVerbInput({
      toolName: "apify_api",
      verbName: "x",
      method: "GET",
      pathTemplate: "/v2/x",
      code: "require('fs').rmSync('/', {recursive:true})",
    });
    expect(result.ok).toBe(false);
  });

  // ── Hard constraint 4: canonical ProviderVerbSpec field shape ────────────
  it("rejects an invalid HTTP method", () => {
    const result = validateCreateVerbInput({
      ...VALID_ARGS,
      method: "TRACE",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing pathTemplate", () => {
    const { pathTemplate: _drop, ...rest } = VALID_ARGS;
    const result = validateCreateVerbInput(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects a missing toolName", () => {
    const { toolName: _drop, ...rest } = VALID_ARGS;
    const result = validateCreateVerbInput(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed workspaceId (not a UUID)", () => {
    const result = validateCreateVerbInput({
      ...VALID_ARGS,
      workspaceId: "not-a-uuid",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts optional query/body/responseShape using canonical field names", () => {
    const result = validateCreateVerbInput({
      ...VALID_ARGS,
      query: { limit: "{{limit}}", tags: ["a", "b"] },
      body: { input: { query: "{{query}}" } },
      responseShape: { collectionPath: "items", collectionAs: "results" },
    });
    expect(result.ok).toBe(true);
  });

  it("strips unknown fields rather than accepting invented ones (e.g. no `endpoint` shorthand)", () => {
    const result = validateCreateVerbInput({
      ...VALID_ARGS,
      endpoint: "/v2/should-be-ignored",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>).endpoint).toBeUndefined();
      // The canonical field name is still the one that took effect.
      expect(result.data.pathTemplate).toBe(VALID_ARGS.pathTemplate);
    }
  });

  // ── GraphQL transport (Wave 0) ───────────────────────────────────────────
  const GRAPHQL_ARGS = {
    toolName: "fireflies",
    verbName: "fireflies_search",
    method: "POST",
    pathTemplate: "/graphql",
    transport: "graphql",
    graphql: {
      query: "query Q($k: String) { transcripts(keyword: $k) { id } }",
      variables: { k: "{{query}}" },
      operation: "query",
      dataPath: "data",
    },
    parameters: { query: "string" },
  };

  it("accepts a well-formed GraphQL verb", () => {
    const result = validateCreateVerbInput(GRAPHQL_ARGS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.transport).toBe("graphql");
      expect(result.data.graphql?.operation).toBe("query");
    }
  });

  it('rejects transport:"graphql" with no graphql.query', () => {
    const { graphql: _drop, ...rest } = GRAPHQL_ARGS;
    const result = validateCreateVerbInput(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/graphql\.query/i);
  });

  it("rejects mixing a GraphQL verb with a REST query", () => {
    const result = validateCreateVerbInput({
      ...GRAPHQL_ARGS,
      query: { limit: "{{limit}}" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot also set REST/i);
  });

  it("rejects mixing a GraphQL verb with a REST body", () => {
    const result = validateCreateVerbInput({
      ...GRAPHQL_ARGS,
      body: { title: "{{title}}" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a graphql block with an invalid operation", () => {
    const result = validateCreateVerbInput({
      ...GRAPHQL_ARGS,
      graphql: { ...GRAPHQL_ARGS.graphql, operation: "subscription" },
    });
    expect(result.ok).toBe(false);
  });
});
