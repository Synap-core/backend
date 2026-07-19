import { describe, it, expect, beforeEach, vi } from "vitest";

// Boundary mocks. handleEntityEmbedding is thin orchestration: load the entity
// row, build the embedding text, fetch the vector from the IS, upsert it. We
// mock the four boundaries and assert the load → (skip | embed+upsert) branch.
const { selectRows, sqlMock, fetchMock, buildTextMock, resolveEndpointMock } =
  vi.hoisted(() => ({
    selectRows: { value: [] as Array<Record<string, unknown>> },
    sqlMock: vi.fn(async () => undefined),
    fetchMock: vi.fn(),
    buildTextMock: vi.fn(() => "text-to-embed"),
    resolveEndpointMock: vi.fn(async () => ({
      endpoint: "http://is.local",
      apiKey: "test-key",
    })),
  }));

vi.mock("@synap/database", () => ({
  sql: sqlMock,
  resolveDefaultIntelligenceEndpoint: resolveEndpointMock,
  entities: {},
  eq: vi.fn(),
  // The worker loads live facets (Kind+Facets) before deciding to embed. No
  // facets attached in these boundary cases → the embedding text is title-only,
  // which is what the assertions below pin. Present so the mock covers every
  // `@synap/database` export the worker destructures.
  getEffectiveFacets: vi.fn(async () => []),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => selectRows.value),
        })),
      })),
    })),
  },
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@synap/ai-embeddings", () => ({
  buildEntityEmbeddingText: buildTextMock,
}));

import { handleEntityEmbedding } from "../entity-embedding.js";

const asJob = (data: Record<string, unknown>) =>
  ({ data }) as unknown as Parameters<typeof handleEntityEmbedding>[0];

beforeEach(() => {
  selectRows.value = [];
  sqlMock.mockClear();
  buildTextMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("handleEntityEmbedding", () => {
  it("skips (no fetch, no upsert) when the entity has no title", async () => {
    // No title in the payload and none on the loaded row → nothing to embed.
    selectRows.value = [
      { title: null, type: "note", preview: null, properties: null },
    ];

    await handleEntityEmbedding(asJob({ entityId: "e1", userId: "u1" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("builds text, fetches the embedding, and upserts when a title exists", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: new Array(1536).fill(0.1) }),
    });

    await handleEntityEmbedding(
      asJob({ entityId: "e2", userId: "u2", title: "Sample note" })
    );

    expect(buildTextMock).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://is.local/api/embeddings",
      expect.objectContaining({ method: "POST" })
    );
    // The vector upsert ran (raw sql tagged-template).
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
