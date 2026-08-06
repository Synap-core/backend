import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const restEntitiesPath = fileURLToPath(
  new URL("../routers/hub-protocol/rest/entities.ts", import.meta.url)
);

describe("tripwire: Hub GET /entities/:id uses the canonical entity codec", () => {
  it("does not expose a raw entity row", () => {
    const source = readFileSync(restEntitiesPath, "utf8");
    const getRoute = source.slice(source.indexOf("const getEntityRoute"));
    expect(getRoute).toContain("schema: WireEntitySchema");
    expect(getRoute).toContain("return c.json(entityToWire(result), 200)");
  });
});
