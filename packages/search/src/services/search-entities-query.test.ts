/**
 * The keyword half of recall finds an entity by its summary and its body, not
 * only its title (ticket 75134529: a note was found only when the question
 * repeated its title).
 *
 * Driven through the real indexer and the real search service. Typesense is
 * replaced by a small in-memory stand-in that matches a document when every
 * query word appears in one of the fields the service names in `query_by` —
 * so what is found depends on what the service asks Typesense to search.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { store, calls } = vi.hoisted(() => ({
  store: [] as Array<Record<string, unknown>>,
  calls: [] as Array<Record<string, unknown>>,
}));

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_.€]+/gu) ?? [];
}

function fakeSearch(params: Record<string, unknown>) {
  calls.push(params);
  const fields = String(params.query_by).split(",");
  const wanted = words(String(params.q));
  const hits = store
    .filter((doc) => {
      const text = fields
        .flatMap((f) => {
          const v = doc[f];
          return Array.isArray(v) ? v : v == null ? [] : [String(v)];
        })
        .join(" ");
      const have = new Set(words(text));
      return wanted.every((w) => have.has(w));
    })
    .map((document) => ({ document, highlights: [], text_match: 1 }));
  return { hits, found: hits.length, search_time_ms: 0 };
}

vi.mock("../client.js", () => ({
  getTypesenseAdminClient: () => ({
    collections: () => ({
      documents: () => ({
        search: async (params: Record<string, unknown>) => fakeSearch(params),
      }),
    }),
    multiSearch: {
      perform: async ({
        searches,
      }: {
        searches: Array<Record<string, unknown>>;
      }) => ({ results: searches.map((s) => fakeSearch(s)) }),
    },
  }),
}));

import { EntityIndexer } from "../indexers/entity-indexer.js";
import { SearchService, collectionQueryParams } from "./search-service.js";

const USER = "11111111-2222-3333-4444-555555555555";

function service(): SearchService {
  const svc = new SearchService();
  // The member-workspace floor reads the database; these rows are the caller's own.
  (
    svc as unknown as { resolveVisibleWorkspaceIds: () => Promise<string[]> }
  ).resolveVisibleWorkspaceIds = async () => [];
  return svc;
}

const base = {
  content: null,
  preview: null,
  userId: USER,
  workspaceId: null,
  projectId: null,
  type: "note",
  tags: null,
  status: null,
  properties: null,
  createdAt: new Date("2026-10-21T00:00:00Z"),
  updatedAt: new Date("2026-10-21T00:00:00Z"),
};

beforeEach(async () => {
  store.length = 0;
  calls.length = 0;
  const indexer = new EntityIndexer();
  store.push(
    await indexer.toSearchDocument({
      ...base,
      id: "pricing-note",
      title: "Pricing",
      preview: "Current pricing from the control plane: €20 Pod",
    }),
    await indexer.toSearchDocument({
      ...base,
      id: "governance-note",
      title: "Governance, proposals and permissions",
      // A document-backed note: IndexingService folds the body into `content`.
      content:
        "Backfill of autoApproveFor JSONB into governance_rules at rung 2.8",
    }),
    await indexer.toSearchDocument({
      ...base,
      id: "unrelated",
      title: "Onboarding north star",
    })
  );
});

const ids = (r: { results: Array<{ id: string }> }) =>
  r.results.map((x) => x.id);

describe("entities keyword search reaches the summary and the body", () => {
  it("a query matching only an entity's description finds it (searchCollection)", async () => {
    const r = await service().searchCollection("entities", "control plane", {
      userId: USER,
    });
    expect(ids(r)).toEqual(["pricing-note"]);
  });

  it("the same through `search`, the call hybrid recall makes", async () => {
    const r = await service().search({
      query: "control plane",
      userId: USER,
      collections: ["entities"],
    });
    expect(ids(r)).toEqual(["pricing-note"]);
  });

  it("a query matching only an entity's body text finds it", async () => {
    const r = await service().searchCollection("entities", "autoApproveFor", {
      userId: USER,
    });
    expect(ids(r)).toEqual(["governance-note"]);
  });

  it("a title-dedup lookup (titleOnly) still matches titles only", async () => {
    const r = await service().searchCollection("entities", "control plane", {
      userId: USER,
      titleOnly: true,
    });
    expect(ids(r)).toEqual([]);
    expect(calls[0].query_by).toBe("title");
    expect(calls[0].query_by_weights).toBeUndefined();
  });

  it("the title is searched first and weighted highest; the body is never returned whole in highlights", () => {
    const p = collectionQueryParams("entities");
    const fields = p.query_by.split(",");
    const weights = (p.query_by_weights ?? "").split(",").map(Number);
    expect(fields[0]).toBe("title");
    expect(fields).toEqual(
      expect.arrayContaining(["description", "content", "searchAliases"])
    );
    expect(weights).toHaveLength(fields.length);
    expect(weights[0]).toBe(Math.max(...weights));
    expect(p.highlight_full_fields.split(",")).not.toContain("content");
  });

  it("other collections keep their query fields", () => {
    expect(collectionQueryParams("documents").query_by).toBe("title");
    expect(collectionQueryParams("views").query_by).toBe("name");
    expect(collectionQueryParams("messages").query_by).toBe("content");
  });
});
