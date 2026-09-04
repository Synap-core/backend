/**
 * `synap_get_graph({ type: "document" })` returned zero neighbours even for a
 * document body live entities pointed at (`entities.documentId`) — a plain FK
 * column, never mirrored into `links` or `relations`, so no existing fold in
 * `graph-service.ts` ever looked at it. Reported from a live external-agent
 * run: 12 entities read via MCP each carried a `documentId`; `get_graph` on
 * every one of those 11 documents came back `neighbors: []`.
 *
 * `getDocumentBodyNeighbors` closes the reverse edge: `document` focus →
 * entities whose `documentId` points at it. This is WRITTEN-BUT-UNPROVEN
 * against a real Postgres — there is no local DB available in this
 * environment. The DB is faked at the `getDb()` seam (dispatch on table
 * identity, mirroring `temporal-neighbors.test.ts`), which proves the fold's
 * SHAPE and its gating, not that the live SQL predicate actually floors
 * correctly — that half is asserted structurally against the source instead
 * (same limitation the temporal-neighbours test states up front).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const h = vi.hoisted(() => ({
  entityRows: [] as Record<string, unknown>[],
  facetMap: new Map<string, string[]>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();

  const chain = (rows: Record<string, unknown>[]) => {
    const self: Record<string, unknown> = {
      where: () => self,
      limit: () => self,
      then: (
        resolve: (v: Record<string, unknown>[]) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return self;
  };

  const fakeDb = {
    select: () => ({
      from: (table: unknown) => {
        if (table === actual.entities) return chain(h.entityRows);
        return chain([]);
      },
    }),
  };

  return {
    ...actual,
    getDb: async () => fakeDb,
    loadFacetSlugsBatch: vi.fn(async () => h.facetMap),
  };
});

import { getDocumentBodyNeighbors } from "./graph-service.js";

const OWNER = "user-owner";
const DOCUMENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const ENTITY_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const WORKSPACE_ID = "cccccccc-3333-4333-8333-333333333333";

const NO_FACET_SCOPE = {
  workspaceIds: [] as string[],
  isMember: false,
} as unknown as Parameters<typeof getDocumentBodyNeighbors>[3];

beforeEach(() => {
  h.entityRows = [];
  h.facetMap = new Map();
});

describe("getDocumentBodyNeighbors", () => {
  it("is a no-op for every focus kind except 'document' — no DB call", async () => {
    h.entityRows = [
      {
        id: ENTITY_ID,
        title: "Should not surface",
        type: "person",
        workspaceId: WORKSPACE_ID,
      },
    ];
    const out = await getDocumentBodyNeighbors(
      OWNER,
      "entity",
      ENTITY_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    expect(out).toEqual([]);
  });

  it("surfaces the entity whose documentId points at the focused document", async () => {
    h.entityRows = [
      {
        id: ENTITY_ID,
        title: "Q3 Strategy Note",
        type: "note",
        workspaceId: WORKSPACE_ID,
      },
    ];
    h.facetMap = new Map([[ENTITY_ID, ["customer"]]]);

    const out = await getDocumentBodyNeighbors(
      OWNER,
      "document",
      DOCUMENT_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );

    expect(out).toEqual([
      {
        kind: "entity",
        id: ENTITY_ID,
        name: "Q3 Strategy Note",
        subtype: "note",
        subtypes: ["note", "customer"],
        workspaceId: WORKSPACE_ID,
        edgeType: "documentId",
        direction: "incoming",
        via: "body",
      },
    ]);
  });

  it("returns [] when no entity uses this document as its body", async () => {
    h.entityRows = [];
    const out = await getDocumentBodyNeighbors(
      OWNER,
      "document",
      DOCUMENT_ID,
      NO_FACET_SCOPE,
      WORKSPACE_ID
    );
    expect(out).toEqual([]);
  });
});

describe("the floor a fake DB cannot exercise", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "graph-service.ts"),
    "utf8"
  );
  const fn = src.slice(
    src.indexOf("export async function getDocumentBodyNeighbors"),
    src.indexOf("export async function getDocumentBodyNeighbors") + 2000
  );

  it("floors on the SAME canonical entity read-scope every other entity neighbour uses", () => {
    expect(fn).toContain("accessScopeWhere(");
    expect(fn).toContain("facetLens: true");
  });

  it("excludes soft-deleted entities", () => {
    expect(fn).toContain("isNull(entities.deletedAt)");
  });

  it("bounds the fan-out", () => {
    expect(fn).toContain("DOCUMENT_BODY_NEIGHBOR_CAP");
  });

  it("is wired into getObjectGraph so synap_get_graph actually reaches it", () => {
    const wireUp = src.slice(
      src.indexOf("export async function getObjectGraph")
    );
    expect(wireUp).toContain("getDocumentBodyNeighbors(");
    expect(wireUp).toContain("documentBodyNeighbors");
  });
});
