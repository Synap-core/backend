import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Wave 3 router-decomposition (2026-08-12) moved `batchCreate` out of
// entities.ts into entities/create.ts — a path re-key, not a behavior change.
const entitiesRouterPath = fileURLToPath(
  new URL("../routers/entities/create.ts", import.meta.url)
);
const entityRepositoryPath = fileURLToPath(
  new URL(
    "../../../database/src/repositories/entity-repository.ts",
    import.meta.url
  )
);
const entityUpsertServicePath = fileURLToPath(
  new URL(
    "../../../database/src/services/entity-upsert-service.ts",
    import.meta.url
  )
);

describe("tripwire: Knowledge never bypasses its canonical form contract", () => {
  it("keeps the batch-create, partial-update, and materialized-upsert doors validated", () => {
    const entitiesRouter = readFileSync(entitiesRouterPath, "utf8");
    const batchCreate = entitiesRouter.slice(
      entitiesRouter.indexOf("batchCreate:")
    );
    const repository = readFileSync(entityRepositoryPath, "utf8");
    const upsertService = readFileSync(entityUpsertServicePath, "utf8");

    // Batch imports may retain their historical permissive behavior for
    // non-Knowledge profiles, but never for Knowledge.
    expect(batchCreate).toContain(
      'skipValidation: entity.profileSlug !== "knowledge"'
    );

    // Deletions and a move to Knowledge are full property mutations, rather
    // than a path around the normalizer/required-property validation.
    expect(repository).toContain("data.properties !== undefined");
    expect(repository).toContain(
      'const isMovingToKnowledge = newType === "knowledge"'
    );
    expect(repository).toMatch(
      /const shouldValidateProperties\s*=\s*hasPropertyMutation\s*\|\|\s*isMovingToKnowledge/
    );

    // Capture's identity upsert is another create door. It must not pass
    // skipValidation for Knowledge while preserving importer behavior elsewhere.
    expect(upsertService).toContain(
      'skipValidation: createSlug !== "knowledge"'
    );
  });
});
