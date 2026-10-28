/**
 * A pod whose search index predates the indexer reindexes itself once after a
 * deploy: the boot queues ONE `search-reindex` of the collections behind, and a
 * reindex that succeeded stamps them, so the next boot queues nothing. A failed
 * collection stays unstamped and is retried at the next boot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  stamped: {} as Record<string, number>,
  stampCalls: [] as string[],
  reindexResult: {} as Record<
    string,
    { upserted: number; deleted: number; error?: string }
  >,
}));

vi.mock("@synap/search", () => {
  const SEARCH_INDEX_VERSIONS = { entities: 2 };
  return {
    SEARCH_INDEX_VERSIONS,
    collectionsBehind: (stamped: Record<string, number> = {}) =>
      Object.entries(SEARCH_INDEX_VERSIONS)
        .filter(([c, v]) => (stamped[c] ?? 0) < v)
        .map(([c]) => c),
    readSearchIndexVersions: async () => h.stamped,
    stampSearchIndexVersion: async (collection: string) => {
      h.stampCalls.push(collection);
    },
    indexingService: {
      fullReindex: async () => h.reindexResult,
    },
  };
});

import {
  enqueueSearchReindexIfBehind,
  handleFullReindex,
  SEARCH_INDEX_VERSION_SINGLETON,
} from "../search-worker.js";

beforeEach(() => {
  h.stamped = {};
  h.stampCalls = [];
  h.reindexResult = {};
});

describe("search index version at boot", () => {
  it("queues one reindex of the collections behind, under a singleton key", async () => {
    const send = vi.fn(async () => "job-1");
    const queued = await enqueueSearchReindexIfBehind({ send } as never);

    expect(queued).toEqual(["entities"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      "search-reindex",
      { collections: ["entities"] },
      { singletonKey: SEARCH_INDEX_VERSION_SINGLETON }
    );
  });

  it("queues nothing when the pod is stamped at the current version", async () => {
    h.stamped = { entities: 2 };
    const send = vi.fn();
    expect(await enqueueSearchReindexIfBehind({ send } as never)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("a successful reindex stamps the collection; a failed one does not", async () => {
    h.reindexResult = { entities: { upserted: 3, deleted: 0 } };
    await handleFullReindex({ data: { collections: ["entities"] } } as never);
    expect(h.stampCalls).toEqual(["entities"]);

    h.stampCalls = [];
    h.reindexResult = {
      entities: { upserted: 0, deleted: 0, error: "Typesense down" },
    };
    await handleFullReindex({ data: { collections: ["entities"] } } as never);
    expect(h.stampCalls).toEqual([]);
  });

  it("an unversioned collection is never stamped", async () => {
    h.reindexResult = { views: { upserted: 1, deleted: 0 } };
    await handleFullReindex({ data: { collections: ["views"] } } as never);
    expect(h.stampCalls).toEqual([]);
  });
});
