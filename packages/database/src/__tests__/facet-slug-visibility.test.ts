import { describe, expect, test } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  loadAllFacetSlugsBatchForTrustedIndexing,
  loadFacetSlugsBatch,
} from "../services/facet-resolution-service.js";

const dialect = new PgDialect();

function mockDb() {
  let where: SQL | undefined;
  const rows = [
    { entityId: "entity-1", slug: "client" },
    { entityId: "entity-1", slug: "partner" },
  ];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async (condition: SQL) => {
            where = condition;
            return rows;
          },
        }),
      }),
    }),
  } as unknown as Parameters<typeof loadFacetSlugsBatch>[0];

  return {
    db,
    sql: () => {
      if (!where) throw new Error("query was not executed");
      return dialect.sqlToQuery(where);
    },
  };
}

describe("facet slug batch visibility", () => {
  test("no-lens reads include only allowed workspaces plus the caller's pod roles", async () => {
    const query = mockDb();
    const result = await loadFacetSlugsBatch(query.db, ["entity-1"], {
      userId: "user-a",
      allowedWorkspaceIds: ["workspace-a"],
    });
    const compiled = query.sql();

    expect(result.get("entity-1")).toEqual(["client", "partner"]);
    expect(compiled.sql).toContain('"entity_facets"."workspace_id" in');
    expect(compiled.sql).toContain('"entity_facets"."workspace_id" is null');
    expect(compiled.sql).toContain('"entity_facets"."user_id" =');
    expect(compiled.params).toContain("workspace-a");
    expect(compiled.params).toContain("user-a");
    expect(compiled.params).not.toContain("workspace-b");
  });

  test("an explicit lens is still owner-floored for pod-wide roles", async () => {
    const query = mockDb();
    await loadFacetSlugsBatch(query.db, ["entity-1"], {
      userId: "user-a",
      workspaceId: "workspace-a",
    });
    const compiled = query.sql();

    expect(compiled.params).toContain("workspace-a");
    expect(compiled.params).toContain("user-a");
    expect(compiled.sql).toContain('"entity_facets"."workspace_id" is null');
  });

  test("only the trusted indexing wrapper omits the visibility predicate", async () => {
    const query = mockDb();
    await loadAllFacetSlugsBatchForTrustedIndexing(query.db, ["entity-1"]);
    const compiled = query.sql();

    expect(compiled.sql).toContain('"entity_facets"."entity_id" in');
    expect(compiled.sql).toContain('"entity_facets"."deleted_at" is null');
    expect(compiled.sql).not.toContain('"entity_facets"."workspace_id"');
    expect(compiled.sql).not.toContain('"entity_facets"."user_id"');
  });
});
