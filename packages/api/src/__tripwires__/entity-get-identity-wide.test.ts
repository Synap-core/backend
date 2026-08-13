import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entitiesRouter = fs.readFileSync(
  path.resolve(here, "../routers/entities.ts"),
  "utf8"
);
const facetVisibility = fs.readFileSync(
  path.resolve(here, "../../../database/src/utils/facet-visibility.ts"),
  "utf8"
);

describe("entities.get identity-wide contract", () => {
  it("does not derive its profile or role envelope from ambient lens state", () => {
    const getStart = entitiesRouter.indexOf("get: podProcedure");
    // Wave 3 router-decomposition (2026-08-12): `get` is now the LAST
    // procedure declared inline in the entities.ts barrel (every other
    // procedure moved into co-located entities/*.ts modules and is merely
    // referenced here as `foo: fooProcs.foo`), so its body runs to the
    // router-object's own closing `});` rather than to a sibling `update:`
    // declaration. Boundary marker updated for the new file layout only —
    // the assertions below (what `get`'s source must/must not contain) are
    // unchanged.
    const updateStart = entitiesRouter.indexOf("\n});", getStart);
    const getSource = entitiesRouter.slice(getStart, updateStart);

    expect(getStart).toBeGreaterThan(-1);
    expect(updateStart).toBeGreaterThan(getStart);
    expect(getSource).not.toContain("ctx.workspaceId");
    expect(getSource).not.toContain("input.workspaceId !== undefined");
    expect(getSource).toContain("entityWorkspaceId");
    expect(getSource).toContain("getEffectiveFacets(database, entity.id");
    expect(getSource).toContain("allowedWorkspaceIds");
    expect(getSource).toContain("effectivePropertiesByWorkspace");
    expect(getSource).toContain("stableAllowedWorkspaceIds.map");
    expect(getSource).toContain("await Promise.all");
  });

  it("limits the unscoped role envelope to the caller's workspace floor", () => {
    expect(facetVisibility).toContain("allowedWorkspaceIds?: string[]");
    expect(facetVisibility).toContain("inArray(entityFacets.workspaceId");
    expect(facetVisibility).toContain("eq(entityFacets.userId, opts.userId)");
  });
});
