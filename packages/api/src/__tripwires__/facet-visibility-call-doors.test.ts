import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const thisFile = fileURLToPath(import.meta.url);
const apiRoot = path.resolve(here, "..");
const backendRoot = path.resolve(here, "../../../..");

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(backendRoot, relativePath), "utf8");
}

describe("facet visibility call doors", () => {
  it("keeps the unfiltered loader out of every API source file", () => {
    const stack = [apiRoot];
    const sources: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(absolute);
        else if (entry.name.endsWith(".ts") && absolute !== thisFile)
          sources.push(fs.readFileSync(absolute, "utf8"));
      }
    }

    expect(sources.join("\n")).not.toContain(
      "loadAllFacetSlugsBatchForTrustedIndexing"
    );
  });

  it("reserves the trusted loader for search indexing and annotates view rows", () => {
    const indexing = read("packages/search/src/services/indexing-service.ts");
    const views = read("packages/api/src/routers/views.ts");

    expect(indexing).toContain("loadAllFacetSlugsBatchForTrustedIndexing");
    expect(views).toContain("loadFacetSlugsBatch(");
    expect(views).toContain(
      "facetSlugs: facetSlugsByEntity.get(entity.id) ?? []"
    );
    expect(views).toContain("entities: annotatedEntities");
  });

  it("keeps Hub reads and both graph halves on the same explicit visibility scope", () => {
    const hubEntities = read(
      "packages/api/src/routers/hub-protocol/rest/entities.ts"
    );
    const graph = read("packages/api/src/routers/graph.ts");
    const relations = read("packages/api/src/routers/relations.ts");

    expect(hubEntities).toContain(
      "await resolveFacetVisibilityScope(authUserId)"
    );
    expect(graph).toContain("workspaceId: input.workspaceId");
    expect(
      read("packages/api/src/services/object-graph/entity-data-graph.ts")
    ).toContain("workspaceId,");
    expect(relations).toContain(
      "resolveFacetVisibilityScope(\n        ctx.userId,\n        input.workspaceId"
    );
  });

  it("validates role context entities through the same user visibility floor", () => {
    const entitiesRouter = read("packages/api/src/routers/entities.ts");

    expect(entitiesRouter).toContain(
      "eq(entities.id, input.contextEntityId),\n            isNull(entities.deletedAt),\n            entityVisibleWhere(ctx.userId)"
    );
    expect(entitiesRouter).toContain(
      "message: `Context entity not found: ${input.contextEntityId}`"
    );
  });

  // A pod-member reviewer must see a legitimately pod-shared facet's live
  // state in a proposal diff — `isFacetVisibleForLens` fails CLOSED to the
  // owner floor unless its 4th `viewerIsPodMember` arg is threaded through. If
  // either proposals.ts call site regresses to the 3-arg form, a pod-member
  // reviewing someone else's pod-shared facet update silently loses the
  // before-state (under-render, not a leak — but still the bug this guards).
  it("threads viewerIsPodMember into both proposals.ts isFacetVisibleForLens call sites", () => {
    const proposalsRouter = read("packages/api/src/routers/proposals.ts");
    const callSites = [
      ...proposalsRouter.matchAll(/isFacetVisibleForLens\(([\s\S]*?)\)/g),
    ];

    expect(callSites.length).toBeGreaterThanOrEqual(2);
    for (const call of callSites) {
      expect(call[1]).toContain("viewerIsPodMember");
    }
  });
});
