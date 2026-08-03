/**
 * Provider-verb engine — GraphQL transport coverage (Wave 0, "The Arch").
 *
 * `triggerProviderAction` is mocked so these assert the ENGINE's GraphQL logic in
 * isolation: request-build, operation→governance (alreadyApproved), 200-with-
 * errors[]→error (never swallowed as success), dataPath unwrap + responseShape,
 * and that `transport` absent stays byte-identical REST.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../connectors/external-dispatch.js", () => ({
  triggerProviderAction: vi.fn(),
}));

import {
  buildProviderRequest,
  executeProviderVerb,
} from "./execute-provider-verb.js";
import { triggerProviderAction } from "../../connectors/external-dispatch.js";
import type { ProviderVerbSpec } from "@synap/database/schema";

const opts = { userId: "u1" };
const mockDispatch = vi.mocked(triggerProviderAction);

const searchSpec: ProviderVerbSpec = {
  tool: "fireflies",
  method: "POST",
  pathTemplate: "/graphql",
  transport: "graphql",
  graphql: {
    query:
      "query Search($keyword: String) { transcripts(keyword: $keyword) { id title } }",
    variables: { keyword: "{{query}}" },
    operation: "query",
    dataPath: "data",
  },
  responseShape: {
    collectionPath: "transcripts",
    collectionAs: "results",
    item: { id: "id", title: "title" },
    scalar: { count: "@count" },
  },
};

describe("buildProviderRequest — GraphQL transport", () => {
  it("POSTs a { query, variables } body, forces POST, no URL query string", () => {
    const parts = buildProviderRequest(
      // deliberately GET to prove the method is FORCED to POST for GraphQL
      { ...searchSpec, method: "GET" },
      { query: "standup" }
    );
    expect(parts.method).toBe("POST");
    expect(parts.query).toBe("");
    expect(parts.path).toBe("/graphql");
    expect(parts.body).toEqual({
      query:
        "query Search($keyword: String) { transcripts(keyword: $keyword) { id title } }",
      variables: { keyword: "standup" },
    });
  });

  it("interpolates {{param}} inside the graphql query string and defaults variables to {}", () => {
    const spec: ProviderVerbSpec = {
      tool: "t",
      method: "POST",
      pathTemplate: "/graphql",
      transport: "graphql",
      graphql: { query: 'query { thing(id: "{{id}}") { x } }' },
    };
    const parts = buildProviderRequest(spec, { id: "abc" });
    expect((parts.body as { query: string }).query).toContain('id: "abc"');
    expect((parts.body as { variables: unknown }).variables).toEqual({});
  });

  it("REST (transport absent) is unchanged — spec.body/query, method preserved", () => {
    const spec: ProviderVerbSpec = {
      tool: "t",
      method: "GET",
      pathTemplate: "/messages",
      query: { limit: "{{limit}}" },
    };
    const parts = buildProviderRequest(spec, { limit: 10 });
    expect(parts.method).toBe("GET");
    expect(parts.query).toBe("limit=10");
    expect(parts.body).toBeUndefined();
  });
});

describe("executeProviderVerb — GraphQL execution", () => {
  beforeEach(() => mockDispatch.mockReset());

  it("operation:'query' dispatches as a READ (alreadyApproved:true)", async () => {
    mockDispatch.mockResolvedValueOnce({
      success: true,
      body: { data: { transcripts: [] } },
    } as never);
    await executeProviderVerb(searchSpec, { query: "x" }, opts);
    expect(mockDispatch).toHaveBeenCalledOnce();
    const arg = mockDispatch.mock.calls[0]![0] as {
      alreadyApproved: boolean;
      method: string;
    };
    expect(arg.alreadyApproved).toBe(true);
    // All GraphQL is a POST even for a read.
    expect(arg.method).toBe("POST");
  });

  it("operation:'mutation' (and default) dispatches as a WRITE (alreadyApproved:false)", async () => {
    mockDispatch.mockResolvedValue({
      success: true,
      body: { data: {} },
    } as never);
    // explicit mutation
    await executeProviderVerb(
      {
        ...searchSpec,
        graphql: { ...searchSpec.graphql!, operation: "mutation" },
      },
      {},
      opts
    );
    expect(
      (mockDispatch.mock.calls[0]![0] as { alreadyApproved: boolean })
        .alreadyApproved
    ).toBe(false);
    // default (operation omitted) is fail-closed → write
    const { operation: _drop, ...gqlNoOp } = searchSpec.graphql!;
    await executeProviderVerb({ ...searchSpec, graphql: gqlNoOp }, {}, opts);
    expect(
      (mockDispatch.mock.calls[1]![0] as { alreadyApproved: boolean })
        .alreadyApproved
    ).toBe(false);
  });

  it("unwraps dataPath and applies responseShape on a 200 success", async () => {
    mockDispatch.mockResolvedValueOnce({
      success: true,
      body: {
        data: {
          transcripts: [
            { id: "1", title: "A" },
            { id: "2", title: "B" },
          ],
        },
      },
    } as never);
    const out = await executeProviderVerb(searchSpec, { query: "x" }, opts);
    expect(out).toEqual({
      count: 2,
      results: [
        { id: "1", title: "A" },
        { id: "2", title: "B" },
      ],
    });
  });

  it("a 200 body carrying errors[] is surfaced as a FAILURE envelope — never swallowed as success", async () => {
    mockDispatch.mockResolvedValueOnce({
      success: true,
      body: {
        data: null,
        errors: [{ message: "rate limited" }, { message: "try later" }],
      },
    } as never);
    const out = (await executeProviderVerb(
      searchSpec,
      { query: "x" },
      opts
    )) as {
      success: boolean;
      error: string;
      errorClass: string;
    };
    // The engine flattens to a success:false envelope so the caller's ONE failure
    // channel (capErrorMessage: success===false) fires — the whole point.
    expect(out.success).toBe(false);
    expect(out.error).toContain("rate limited");
    expect(out.error).toContain("try later");
    expect(out.errorClass).toBe("provider");
    // It must NOT have been shaped as a results collection.
    expect((out as Record<string, unknown>).results).toBeUndefined();
  });

  it("a transport failure still flows through unchanged (REST-parity error path)", async () => {
    mockDispatch.mockResolvedValueOnce({
      success: false,
      error: "fireflies 401",
      errorClass: "auth",
    } as never);
    const out = (await executeProviderVerb(searchSpec, {}, opts)) as {
      success: boolean;
      error: string;
    };
    expect(out.success).toBe(false);
    expect(out.error).toBe("fireflies 401");
  });
});
