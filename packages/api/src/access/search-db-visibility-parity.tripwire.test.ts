/**
 * SEARCH ↔ DB VISIBILITY-PARITY TRIPWIRE.
 *
 * The durable anti-drift guard for "a shared entity is in `entities.list` but NOT
 * in Cmd-K / recall". The DB entity floor (`accessScopeWhere`, facetLens) admits
 * an entity via owner + workspace-membership + role-as-lens (a facet in a member
 * workspace). The KEYWORD (Typesense) search floor used to be owner-only
 * (`userId:=caller`); it now admits BOTH the owner's rows AND rows shared into a
 * member workspace via the denormalized `visibleInWorkspaces` field.
 *
 * This test asserts that closed gap stays closed, at three levels:
 *
 *   1. EMISSION — `SearchService.buildFilter` for `entities` emits
 *      `(userId:=<caller> || visibleInWorkspaces:=[<caller member ws>])`, and
 *      degrades to owner-only when there are no member workspaces, for non-entity
 *      collections, and preserves the channelId short-circuit.
 *   2. ADMITTED-SET PARITY — over a 2-user / shared-workspace fixture, the set the
 *      REAL emitted keyword floor admits == the set the DB floor's
 *      owner+membership+role-lens branches admit. (Branch 3 EXPOSURE — project /
 *      visible_to — is explicit PHASE 2 for the keyword half and is NOT in this
 *      fixture; the vector half of recall covers it via the real `accessScopeWhere`.)
 *   3. DELETED-AT-AWARE INDEXING — the indexer denormalizes `visibleInWorkspaces`
 *      = own workspace ∪ ACTIVE facet workspaces, and the batch loader that feeds
 *      it filters `deleted_at IS NULL` (a detached/revoked role stops granting the
 *      lens) and skips NULL-workspace (pod-wide) facets.
 *
 * If `resolveVisibleWorkspaceIds` drifts from `getUserWorkspaceIds`, or the floor
 * clause / indexing changes shape, one of these proofs breaks.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SearchService, EntityIndexer, IndexingService } from "@synap/search";

const dialect = new PgDialect();

const svc = new SearchService();
// buildFilter / buildFloor are private; the tripwire drives the REAL logic.
const buildFilter = (opts: Record<string, unknown>): string =>
  (
    svc as unknown as { buildFilter: (o: Record<string, unknown>) => string }
  ).buildFilter(opts);

const CALLER = "user-A";
const MEMBER_WS = ["ws-1", "ws-2"];

// ── 1. Emission ─────────────────────────────────────────────────────────────
describe("keyword entity floor emission", () => {
  it("entities + member workspaces => owner OR visibleInWorkspaces membership", () => {
    const filter = buildFilter({
      userId: CALLER,
      collection: "entities",
      visibleWorkspaceIds: MEMBER_WS,
    });
    expect(filter).toBe(
      "(userId:=`user-A` || visibleInWorkspaces:=[`ws-1`,`ws-2`])"
    );
  });

  it("no member workspaces => owner-only (byte-for-byte the pre-parity floor)", () => {
    expect(
      buildFilter({
        userId: CALLER,
        collection: "entities",
        visibleWorkspaceIds: [],
      })
    ).toBe("userId:=`user-A`");
  });

  it("non-entity collections stay owner-only even with member workspaces", () => {
    expect(
      buildFilter({
        userId: CALLER,
        collection: "documents",
        visibleWorkspaceIds: MEMBER_WS,
      })
    ).toBe("userId:=`user-A`");
  });

  it("channelId short-circuit is preserved (multi-author message gate)", () => {
    expect(
      buildFilter({
        userId: CALLER,
        collection: "messages",
        channelId: "chan-1",
        visibleWorkspaceIds: MEMBER_WS,
      })
    ).toBe("channelId:=`chan-1`");
  });

  it("the specific workspace NARROW is ANDed onto the widened floor", () => {
    const filter = buildFilter({
      userId: CALLER,
      collection: "entities",
      visibleWorkspaceIds: MEMBER_WS,
      workspaceId: "ws-1",
    });
    // Floor (owner OR membership) AND the workspace narrow (ws-1 + pod-wide).
    expect(filter).toBe(
      "(userId:=`user-A` || visibleInWorkspaces:=[`ws-1`,`ws-2`]) && (workspaceId:=`ws-1` || workspaceId:=`__pod_wide__`)"
    );
  });
});

// ── 2. Admitted-set parity ───────────────────────────────────────────────────
/**
 * A fixture row as it exists in the DB (`workspaceId` = its own workspace, null =
 * pod-personal; `facetWs` = the workspaces of its ACTIVE facets) PLUS the
 * `visibleInWorkspaces` the indexer denormalizes (own ws ∪ active facet ws).
 */
interface FixtureEntity {
  id: string;
  userId: string;
  workspaceId: string | null;
  facetWs: string[];
}

const denormVisible = (e: FixtureEntity): string[] => [
  ...new Set(
    [e.workspaceId, ...e.facetWs].filter(
      (w): w is string => typeof w === "string" && w.length > 0
    )
  ),
];

/** Evaluate the REAL emitted keyword floor string against a fixture row. */
function keywordAdmits(floor: string, e: FixtureEntity): boolean {
  const owner = /userId:=`([^`]+)`/.exec(floor)?.[1];
  const wsList =
    /visibleInWorkspaces:=\[([^\]]*)\]/
      .exec(floor)?.[1]
      ?.split(",")
      .map((s) => s.replace(/`/g, "").trim())
      .filter(Boolean) ?? [];
  const visible = denormVisible(e);
  return e.userId === owner || visible.some((w) => wsList.includes(w));
}

/**
 * Reference model of the DB `accessScopeWhere` (facetLens) floor for the branches
 * the keyword half covers — owner (pod-personal) + workspace-membership +
 * role-as-lens. Deliberately excludes the EXPOSURE branch (PHASE 2 for keyword).
 */
function dbFloorAdmits(
  e: FixtureEntity,
  caller: string,
  memberWs: string[]
): boolean {
  const podPersonal = e.workspaceId === null && e.userId === caller;
  const membership = e.workspaceId !== null && memberWs.includes(e.workspaceId);
  const roleLens = e.facetWs.some((w) => memberWs.includes(w));
  return podPersonal || membership || roleLens;
}

describe("admitted-set parity — keyword floor == DB owner+membership+role-lens floor", () => {
  const fixture: FixtureEntity[] = [
    // Owner's own pod-personal entity — admitted by owner branch.
    { id: "own-personal", userId: CALLER, workspaceId: null, facetWs: [] },
    // Another user's entity living in a workspace the caller is a MEMBER of.
    { id: "shared-member", userId: "user-B", workspaceId: "ws-1", facetWs: [] },
    // Another user's pod-wide entity role-attached (facet) in a member workspace.
    {
      id: "shared-rolelens",
      userId: "user-B",
      workspaceId: null,
      facetWs: ["ws-2"],
    },
    // NOT visible: other user's entity in a NON-member workspace, no member facet.
    {
      id: "hidden-ws",
      userId: "user-B",
      workspaceId: "ws-9",
      facetWs: ["ws-9"],
    },
    // NOT visible: other user's pod-personal entity.
    { id: "hidden-personal", userId: "user-B", workspaceId: null, facetWs: [] },
  ];

  it("the real emitted floor admits exactly the DB-floor set", () => {
    const floor = buildFilter({
      userId: CALLER,
      collection: "entities",
      visibleWorkspaceIds: MEMBER_WS,
    });

    const keywordSet = fixture
      .filter((e) => keywordAdmits(floor, e))
      .map((e) => e.id);
    const dbSet = fixture
      .filter((e) => dbFloorAdmits(e, CALLER, MEMBER_WS))
      .map((e) => e.id);

    expect(keywordSet.sort()).toEqual(dbSet.sort());
    // Pin the expected admitted set so a silent widening/narrowing of EITHER
    // model is caught, not just a mutual drift that keeps them equal.
    expect(dbSet.sort()).toEqual(
      ["own-personal", "shared-member", "shared-rolelens"].sort()
    );
  });
});

// ── 3. Deleted-at-aware indexing ─────────────────────────────────────────────
describe("indexer denormalizes visibleInWorkspaces = own ws ∪ active facet ws", () => {
  const indexer = new EntityIndexer();
  const base = {
    title: "t",
    content: null,
    description: null,
    userId: CALLER,
    projectId: null,
    type: "note",
    tags: null,
    status: null,
    properties: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as const;

  it("dedups the entity's own workspace with its active facet workspaces", async () => {
    const doc = await indexer.toSearchDocument({
      ...base,
      id: "e1",
      workspaceId: "ws-1",
      facetSlugs: ["client"],
      facetWorkspaceIds: ["ws-1", "ws-2"],
    });
    expect((doc.visibleInWorkspaces as string[]).sort()).toEqual([
      "ws-1",
      "ws-2",
    ]);
  });

  it("a pod-wide (null workspace) entity exposes ONLY its facet workspaces", async () => {
    const doc = await indexer.toSearchDocument({
      ...base,
      id: "e2",
      workspaceId: null,
      facetSlugs: ["partner"],
      facetWorkspaceIds: ["ws-2"],
    });
    expect(doc.visibleInWorkspaces).toEqual(["ws-2"]);
  });

  it("an un-shared pod-wide entity has no visibleInWorkspaces (owner-gated only)", async () => {
    const doc = await indexer.toSearchDocument({
      ...base,
      id: "e3",
      workspaceId: null,
      facetSlugs: null,
      facetWorkspaceIds: [],
    });
    expect(doc.visibleInWorkspaces).toBeUndefined();
  });
});

describe("facet-workspace batch loader is deletedAt-aware and pod-wide-skipping", () => {
  const indexing = new IndexingService();

  function mockDb() {
    let where: SQL | undefined;
    const rows = [
      { entityId: "e1", workspaceId: "ws-1" },
      { entityId: "e1", workspaceId: null }, // pod-wide facet — must be skipped
      { entityId: "e1", workspaceId: "ws-1" }, // duplicate — must be deduped
      { entityId: "e2", workspaceId: "ws-3" },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: async (condition: SQL) => {
            where = condition;
            return rows;
          },
        }),
      }),
    };
    return {
      db,
      sql: () => {
        if (!where) throw new Error("query was not executed");
        return dialect.sqlToQuery(where);
      },
    };
  }

  it("filters deleted_at IS NULL and skips/dedups NULL-workspace facets", async () => {
    const query = mockDb();
    const result: Map<string, string[]> = await (
      indexing as unknown as {
        loadActiveFacetWorkspaceIds: (
          db: unknown,
          ids: string[]
        ) => Promise<Map<string, string[]>>;
      }
    ).loadActiveFacetWorkspaceIds(query.db, ["e1", "e2"]);

    expect(result.get("e1")).toEqual(["ws-1"]); // null skipped, dup deduped
    expect(result.get("e2")).toEqual(["ws-3"]);

    const compiled = query.sql();
    expect(compiled.sql).toContain('"entity_facets"."deleted_at" is null');
    expect(compiled.sql).toContain('"entity_facets"."entity_id" in');
  });
});
