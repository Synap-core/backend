import { describe, it, expect, beforeEach, vi } from "vitest";

// Boundary mocks. handleEntityEmbedding is thin orchestration: load the entity
// row, build the embedding text, fetch the vector from the IS, upsert it. We
// mock the four boundaries and assert the load → (skip | embed+upsert) branch.
// NOTE ON THE TEXT BUILDER MOCK: it returns a fixed string but the assertions
// below inspect the ARGUMENTS it received (title, documentText), so the tests
// pin what the worker actually assembled — not merely that it called something.
const { selectRows, sqlMock, fetchMock, buildTextMock, resolveEndpointMock } =
  vi.hoisted(() => ({
    // The worker issues up to TWO selects per job (the entity row, then the
    // latest document_version when the entity has a documentId). `value` is a
    // QUEUE consumed in call order — one entry per expected select — so a test
    // can drive both without the second silently re-reading the first's rows.
    selectRows: { value: [] as Array<Array<Record<string, unknown>>> },
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
  entities: {
    id: "entities.id",
    title: "entities.title",
    type: "entities.type",
    preview: "entities.preview",
    properties: "entities.properties",
    documentId: "entities.document_id",
  },
  // The worker also reads the linked document's latest version to fold its text
  // into the embedding. Missing from this mock, the worker's destructuring threw
  // `No "documentVersions" export is defined` — which is what made these two
  // tests fail before they could assert anything.
  documentVersions: {
    content: "document_versions.content",
    documentId: "document_versions.document_id",
    version: "document_versions.version",
  },
  eq: vi.fn(),
  desc: vi.fn(),
  // The worker loads live facets (Kind+Facets) before deciding to embed. No
  // facets attached in these boundary cases → the embedding text is title-only,
  // which is what the assertions below pin. Present so the mock covers every
  // `@synap/database` export the worker destructures.
  getEffectiveFacets: vi.fn(async () => []),
  db: {
    // Minimal query-builder shape covering BOTH shapes the worker uses:
    // .where().limit() (entity) and .where().orderBy().limit() (doc version).
    select: vi.fn(() => {
      const rows = selectRows.value.shift() ?? [];
      const terminal = { limit: vi.fn(async () => rows) };
      const afterWhere = { ...terminal, orderBy: vi.fn(() => terminal) };
      return { from: vi.fn(() => ({ where: vi.fn(() => afterWhere) })) };
    }),
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
      [{ title: null, type: "note", preview: null, properties: null }],
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

    // Assert on the ARGUMENTS, not just that it was called — the payload title
    // must reach the text builder, and no document body was linked.
    expect(buildTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sample note", documentText: null })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://is.local/api/embeddings",
      expect.objectContaining({ method: "POST" })
    );
    // The vector upsert ran (raw sql tagged-template).
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("folds the linked document's latest version text into the embedding", async () => {
    // Entity row carries a documentId → the worker runs a SECOND select for the
    // latest document_version and must pass its content through as documentText.
    selectRows.value = [
      [
        {
          title: "Spec",
          type: "note",
          preview: null,
          properties: null,
          documentId: "d1",
        },
      ],
      [{ content: "the document body" }],
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: new Array(1536).fill(0.1) }),
    });

    await handleEntityEmbedding(asJob({ entityId: "e3", userId: "u3" }));

    expect(buildTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Spec",
        documentText: "the document body",
      })
    );
  });
});
