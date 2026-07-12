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
    const updateStart = entitiesRouter.indexOf(
      "\n  update: podProcedure",
      getStart
    );
    const getSource = entitiesRouter.slice(getStart, updateStart);

    expect(getStart).toBeGreaterThan(-1);
    expect(updateStart).toBeGreaterThan(getStart);
    expect(getSource).not.toContain("ctx.workspaceId");
    expect(getSource).not.toContain("input.workspaceId !== undefined");
    expect(getSource).toContain("entityWorkspaceId");
    expect(getSource).toContain("getEffectiveFacets(database, entity.id");
    expect(getSource).toContain("allowedWorkspaceIds");
  });

  it("limits the unscoped role envelope to the caller's workspace floor", () => {
    expect(facetVisibility).toContain("allowedWorkspaceIds?: string[]");
    expect(facetVisibility).toContain("inArray(entityFacets.workspaceId");
    expect(facetVisibility).toContain("eq(entityFacets.userId, opts.userId)");
  });
});
