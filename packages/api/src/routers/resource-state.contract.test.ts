import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const resourceStateSource = readFileSync(
  new URL("./resource-state.ts", import.meta.url),
  "utf8"
);
const entitiesSource = readFileSync(
  new URL("./entities.ts", import.meta.url),
  "utf8"
);

describe("resource state API contract", () => {
  it("keeps open telemetry behind an explicit mutation", () => {
    expect(resourceStateSource).toContain("open: protectedProcedure");
    expect(resourceStateSource).toContain("repository.recordOpen(");
    expect(entitiesSource).not.toContain("userResourceState");
    expect(entitiesSource).not.toContain("access-bump upsert");
  });

  it("supports entity/view pin, star, and semantic size state", () => {
    expect(resourceStateSource).toContain('z.enum(["entity", "view"])');
    expect(resourceStateSource).toContain("pinned: z.boolean().optional()");
    expect(resourceStateSource).toContain("starred: z.boolean().optional()");
    expect(resourceStateSource).toContain(
      "semanticSize: semanticSizeSchema.nullable().optional()"
    );
  });

  it("hydrates a bounded resource page without per-card state reads", () => {
    expect(resourceStateSource).toContain("list: protectedProcedure");
    expect(resourceStateSource).toContain(
      "z.array(resourceIdentitySchema).max(5000)"
    );
    expect(resourceStateSource).toContain("repository.getMany(");
    expect(resourceStateSource).toContain("filterVisibleResources(");
  });
});
