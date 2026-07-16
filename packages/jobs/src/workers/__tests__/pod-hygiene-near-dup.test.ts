import { describe, expect, it, vi } from "vitest";

/**
 * Fully mock @synap/database so pure-helper unit tests never open a DB
 * connection. pickMergeWinner / buildPropertyUnion reimplemented here with the
 * same semantics as EntityMergeService (SSOT is unit-tested in @synap/database).
 */
vi.mock("@synap/database", () => {
  function isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === "string" && value.trim() === "") return true;
    return false;
  }

  function countNonEmpty(props: Record<string, unknown>): number {
    return Object.values(props).filter((v) => !isEmpty(v)).length;
  }

  return {
    db: {},
    entities: {},
    entityVectors: {},
    proposals: {},
    insertPendingProposal: vi.fn(),
    eq: vi.fn(),
    and: vi.fn(),
    isNull: vi.fn(),
    inArray: vi.fn(),
    gte: vi.fn(),
    lt: vi.fn(),
    desc: vi.fn(),
    drizzleSql: vi.fn(),
    ProposalStatus: { PENDING: "pending" },
    pickMergeWinner: (
      a: {
        id: string;
        createdAt: Date;
        properties: Record<string, unknown>;
        title: string | null;
      },
      b: {
        id: string;
        createdAt: Date;
        properties: Record<string, unknown>;
        title: string | null;
      }
    ) => {
      const ac = countNonEmpty(a.properties);
      const bc = countNonEmpty(b.properties);
      if (ac !== bc) {
        return ac > bc
          ? { winnerId: a.id, loserId: b.id, reason: "props" }
          : { winnerId: b.id, loserId: a.id, reason: "props" };
      }
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return a.createdAt.getTime() < b.createdAt.getTime()
          ? { winnerId: a.id, loserId: b.id, reason: "older" }
          : { winnerId: b.id, loserId: a.id, reason: "older" };
      }
      return a.id < b.id
        ? { winnerId: a.id, loserId: b.id, reason: "id" }
        : { winnerId: b.id, loserId: a.id, reason: "id" };
    },
    buildPropertyUnion: (
      winnerProps: Record<string, unknown>,
      loserProps: Record<string, unknown>
    ) => {
      const merged = { ...winnerProps };
      const filled: string[] = [];
      const conflicts: Array<{
        key: string;
        winnerValue: unknown;
        loserValue: unknown;
      }> = [];
      for (const [key, loserValue] of Object.entries(loserProps)) {
        if (isEmpty(loserValue)) continue;
        const winnerValue = winnerProps[key];
        if (isEmpty(winnerValue)) {
          merged[key] = loserValue;
          filled.push(key);
        } else if (JSON.stringify(winnerValue) !== JSON.stringify(loserValue)) {
          conflicts.push({ key, winnerValue, loserValue });
        }
      }
      return { merged, filled, conflicts };
    },
  };
});

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

/** alias() needs a real PgTable; stub column handles for unit tests. */
vi.mock("drizzle-orm/pg-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm/pg-core")>();
  return {
    ...actual,
    alias: (_table: unknown, name: string) =>
      ({
        entityId: `${name}.entityId`,
        userId: `${name}.userId`,
        entityType: `${name}.entityType`,
        embedding: `${name}.embedding`,
      }) as never,
  };
});

import {
  normalizeTitle,
  normalizeEmail,
  pairKey,
  sameWorkspace,
  findNearDupPairs,
  findEmbeddingNearDupPairs,
  mergeNearDupPairLists,
  buildMergeProposalData,
  resolveMethodAndConfidence,
  EMBEDDING_MIN_SIMILARITY,
  EMBEDDING_MAX_DISTANCE,
  CONFIDENCE_EMBEDDING,
  type NearDupEntity,
  type NearDupPair,
  type NearDupDb,
} from "../pod-hygiene-near-dup.js";

function entity(
  partial: Partial<NearDupEntity> & { id: string }
): NearDupEntity {
  return {
    title: partial.title ?? null,
    type: partial.type ?? "person",
    properties: partial.properties ?? {},
    workspaceId: partial.workspaceId ?? "ws-1",
    userId: partial.userId ?? "user-1",
    createdAt: partial.createdAt ?? new Date("2024-01-01T00:00:00Z"),
    id: partial.id,
  };
}

describe("normalizeTitle", () => {
  it("lowercases and trims", () => {
    expect(normalizeTitle("  Alice Smith  ")).toBe("alice smith");
  });

  it("returns null for empty / whitespace / null", () => {
    expect(normalizeTitle(null)).toBeNull();
    expect(normalizeTitle(undefined)).toBeNull();
    expect(normalizeTitle("   ")).toBeNull();
    expect(normalizeTitle("")).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims valid emails", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("rejects non-emails", () => {
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
  });
});

describe("pairKey / sameWorkspace", () => {
  it("orders pair keys canonically", () => {
    expect(pairKey("b", "a")).toBe("a:b");
    expect(pairKey("a", "b")).toBe("a:b");
  });

  it("requires workspace equality including null↔null", () => {
    expect(sameWorkspace("ws-1", "ws-1")).toBe(true);
    expect(sameWorkspace(null, null)).toBe(true);
    expect(sameWorkspace("ws-1", "ws-2")).toBe(false);
    expect(sameWorkspace(null, "ws-1")).toBe(false);
  });
});

describe("findNearDupPairs", () => {
  it("pairs exact title matches within the same workspace", () => {
    const a = entity({ id: "1", title: "Alice Smith" });
    const b = entity({ id: "2", title: "  alice smith " });
    const c = entity({
      id: "3",
      title: "Alice Smith",
      workspaceId: "ws-other",
    });
    const pairs = findNearDupPairs([a, b, c]);
    expect(pairs).toHaveLength(1);
    expect(pairKey(pairs[0]!.a.id, pairs[0]!.b.id)).toBe(pairKey("1", "2"));
    expect(resolveMethodAndConfidence(pairs[0]!)).toEqual({
      method: "exact_title",
      confidence: 0.75,
    });
  });

  it("pairs shared email property as strong_signal at high confidence", () => {
    const a = entity({
      id: "1",
      title: "A",
      properties: { email: "Alice@Ex.com" },
    });
    const b = entity({
      id: "2",
      title: "B",
      properties: { email: "alice@ex.com" },
    });
    const pairs = findNearDupPairs([a, b]);
    expect(pairs).toHaveLength(1);
    expect(resolveMethodAndConfidence(pairs[0]!)).toEqual({
      method: "strong_signal",
      confidence: 0.95,
    });
    expect(pairs[0]!.signalsMatched).toEqual(["email:alice@ex.com"]);
  });

  it("combines title + email into strong_signal with both channels", () => {
    const a = entity({
      id: "1",
      title: "Alice",
      properties: { email: "a@b.com" },
    });
    const b = entity({
      id: "2",
      title: "alice",
      properties: { email: "a@b.com" },
    });
    const pairs = findNearDupPairs([a, b]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.channels.has("exact_title")).toBe(true);
    expect(pairs[0]!.channels.has("email_property")).toBe(true);
    expect(resolveMethodAndConfidence(pairs[0]!).method).toBe("strong_signal");
    expect(resolveMethodAndConfidence(pairs[0]!).confidence).toBe(0.95);
  });

  it("does not pair different kinds even with same title", () => {
    const a = entity({ id: "1", title: "Acme", type: "company" });
    const b = entity({ id: "2", title: "Acme", type: "person" });
    expect(findNearDupPairs([a, b])).toHaveLength(0);
  });

  it("ranks email pairs above title-only pairs", () => {
    const t1 = entity({ id: "t1", title: "Same Title" });
    const t2 = entity({ id: "t2", title: "Same Title" });
    const e1 = entity({
      id: "e1",
      title: "X",
      properties: { email: "z@z.com" },
    });
    const e2 = entity({
      id: "e2",
      title: "Y",
      properties: { email: "z@z.com" },
    });
    const pairs = findNearDupPairs([t1, t2, e1, e2]);
    expect(pairs.length).toBe(2);
    expect(resolveMethodAndConfidence(pairs[0]!).confidence).toBe(0.95);
    expect(resolveMethodAndConfidence(pairs[1]!).confidence).toBe(0.75);
  });
});

describe("embedding ANN constants", () => {
  it("locks cosine similarity floor at 0.92 (distance ≤ 0.08)", () => {
    expect(EMBEDDING_MIN_SIMILARITY).toBe(0.92);
    expect(EMBEDDING_MAX_DISTANCE).toBe(0.08);
    expect(EMBEDDING_MAX_DISTANCE).toBeCloseTo(1 - EMBEDDING_MIN_SIMILARITY);
    expect(CONFIDENCE_EMBEDDING).toBe(0.85);
  });
});

describe("resolveMethodAndConfidence (embedding channel)", () => {
  function pairWith(
    channels: Array<"exact_title" | "email_property" | "embedding">
  ): NearDupPair {
    return {
      a: entity({ id: "a", title: "A" }),
      b: entity({ id: "b", title: "B" }),
      channels: new Set(channels),
      signalsMatched: [],
    };
  }

  it("maps embedding-only to method embedding @ 0.85", () => {
    expect(resolveMethodAndConfidence(pairWith(["embedding"]))).toEqual({
      method: "embedding",
      confidence: CONFIDENCE_EMBEDDING,
    });
  });

  it("prefers email over embedding over exact_title", () => {
    expect(
      resolveMethodAndConfidence(
        pairWith(["email_property", "embedding", "exact_title"])
      )
    ).toEqual({ method: "strong_signal", confidence: 0.95 });

    expect(
      resolveMethodAndConfidence(pairWith(["embedding", "exact_title"]))
    ).toEqual({ method: "embedding", confidence: CONFIDENCE_EMBEDDING });

    expect(resolveMethodAndConfidence(pairWith(["exact_title"]))).toEqual({
      method: "exact_title",
      confidence: 0.75,
    });
  });
});

describe("mergeNearDupPairLists", () => {
  it("unions channels for the same unordered pair and re-ranks", () => {
    const titleSame: NearDupPair[] = [
      {
        a: entity({ id: "1", title: "Same" }),
        b: entity({ id: "2", title: "Same" }),
        channels: new Set(["exact_title"]),
        signalsMatched: [],
      },
    ];
    const embeddingOnly: NearDupPair[] = [
      {
        a: entity({ id: "1", title: "Alice" }),
        b: entity({ id: "2", title: "Alyce" }),
        channels: new Set(["embedding"]),
        signalsMatched: [],
      },
    ];
    const merged = mergeNearDupPairLists(titleSame, embeddingOnly);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.channels.has("exact_title")).toBe(true);
    expect(merged[0]!.channels.has("embedding")).toBe(true);
    expect(resolveMethodAndConfidence(merged[0]!)).toEqual({
      method: "embedding",
      confidence: CONFIDENCE_EMBEDDING,
    });
  });

  it("ranks email > embedding > title across merged lists", () => {
    const titlePair: NearDupPair = {
      a: entity({ id: "t1", title: "T" }),
      b: entity({ id: "t2", title: "T" }),
      channels: new Set(["exact_title"]),
      signalsMatched: [],
    };
    const embPair: NearDupPair = {
      a: entity({ id: "e1", title: "X" }),
      b: entity({ id: "e2", title: "Y" }),
      channels: new Set(["embedding"]),
      signalsMatched: [],
    };
    const emailPair: NearDupPair = {
      a: entity({ id: "m1", title: "M", properties: { email: "a@b.com" } }),
      b: entity({ id: "m2", title: "N", properties: { email: "a@b.com" } }),
      channels: new Set(["email_property"]),
      signalsMatched: ["email:a@b.com"],
    };
    const merged = mergeNearDupPairLists([titlePair], [embPair], [emailPair]);
    expect(merged.map((p) => resolveMethodAndConfidence(p).method)).toEqual([
      "strong_signal",
      "embedding",
      "exact_title",
    ]);
  });

  it("drops cross-workspace pairs when merging", () => {
    const bad: NearDupPair = {
      a: entity({ id: "1", workspaceId: "ws-1" }),
      b: entity({ id: "2", workspaceId: "ws-2" }),
      channels: new Set(["embedding"]),
      signalsMatched: [],
    };
    expect(mergeNearDupPairLists([bad])).toHaveLength(0);
  });
});

describe("findEmbeddingNearDupPairs", () => {
  function mockDbReturning(
    rows: Array<{ aId: string; bId: string }>
  ): NearDupDb {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = self;
    chain.from = self;
    chain.innerJoin = self;
    chain.where = self;
    chain.limit = async () => rows;
    return chain as unknown as NearDupDb;
  }

  it("maps vector pairs to embedding channel and filters workspace", async () => {
    const a = entity({ id: "1", title: "Alice", workspaceId: "ws-1" });
    const b = entity({ id: "2", title: "Alyce", workspaceId: "ws-1" });
    const c = entity({ id: "3", title: "Other", workspaceId: "ws-2" });
    const database = mockDbReturning([
      { aId: "1", bId: "2" },
      { aId: "1", bId: "3" }, // cross-workspace — dropped
    ]);
    const pairs = await findEmbeddingNearDupPairs(
      database,
      "user-1",
      "person",
      [a, b, c]
    );
    expect(pairs).toHaveLength(1);
    expect(pairKey(pairs[0]!.a.id, pairs[0]!.b.id)).toBe(pairKey("1", "2"));
    expect(pairs[0]!.channels.has("embedding")).toBe(true);
    expect(resolveMethodAndConfidence(pairs[0]!)).toEqual({
      method: "embedding",
      confidence: CONFIDENCE_EMBEDDING,
    });
  });

  it("returns [] when sample has fewer than 2 entities", async () => {
    const database = mockDbReturning([{ aId: "1", bId: "2" }]);
    expect(
      await findEmbeddingNearDupPairs(database, "user-1", "person", [
        entity({ id: "1" }),
      ])
    ).toEqual([]);
  });

  it("degrades to [] when the query throws", async () => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = self;
    chain.from = self;
    chain.innerJoin = self;
    chain.where = self;
    chain.limit = async () => {
      throw new Error("pgvector unavailable");
    };
    const pairs = await findEmbeddingNearDupPairs(
      chain as unknown as NearDupDb,
      "user-1",
      "person",
      [entity({ id: "1" }), entity({ id: "2" })]
    );
    expect(pairs).toEqual([]);
  });
});

describe("buildMergeProposalData", () => {
  it("emits EntityMergeProposalData shape the approve path can narrow", () => {
    // Both share title + email → strong_signal @ 0.95; "rich" wins (more props).
    const a = entity({
      id: "thin",
      title: "Alice",
      properties: { email: "a@b.com" },
      createdAt: new Date("2024-01-01"),
    });
    const b = entity({
      id: "rich",
      title: "Alice",
      properties: { email: "a@b.com", phone: "1" },
      createdAt: new Date("2025-01-01"),
    });
    const [pair] = findNearDupPairs([a, b]);
    expect(pair).toBeDefined();
    const data = buildMergeProposalData(pair!);
    expect(data.winnerId).toBe("rich");
    expect(data.loserId).toBe("thin");
    expect(data.method).toBe("strong_signal");
    expect(data.confidence).toBe(0.95);
    expect(data.winnerTitle).toBe("Alice");
    expect(data.loserTitle).toBe("Alice");
    expect(data.signalsMatched).toEqual(["email:a@b.com"]);
    expect(data.propertyPlan).toBeDefined();
    // Winner already has email+phone; nothing to fill-null from loser.
    expect(data.propertyPlan!.filled).toEqual([]);
    expect(data.previousWinnerSnapshot?.properties).toEqual(b.properties);
    expect(data.previousLoserSnapshot?.properties).toEqual(a.properties);
    expect(data.summary).toContain("Alice");
    expect(data.reasoning!.length).toBeGreaterThan(20);
  });

  it("labels embedding-only pairs with embedding method + confidence", () => {
    const a = entity({ id: "a1", title: "Alice Smith" });
    const b = entity({ id: "a2", title: "Alyce Smyth" });
    const pair: NearDupPair = {
      a,
      b,
      channels: new Set(["embedding"]),
      signalsMatched: [],
    };
    const data = buildMergeProposalData(pair);
    expect(data.method).toBe("embedding");
    expect(data.confidence).toBe(CONFIDENCE_EMBEDDING);
    expect(data.reasoning).toMatch(/similar embeddings/i);
  });
});
