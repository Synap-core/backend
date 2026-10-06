/**
 * The scoped-key door fence (W1). Rows rule out: a fence that only checks GET
 * (POST reads leak), one that blocks writes (gate already bounds them), one
 * that blocks the seamed reads a site needs, and a full-access key fenced.
 */
import { describe, expect, it } from "vitest";
import {
  isFencedGrant,
  mcpToolAllowed,
  restDoorAllowed,
  trpcProcedureAllowed,
} from "./grant-door-fence.js";

describe("isFencedGrant", () => {
  it("fences a narrow grant, never a legacy key or the explicit '*'", () => {
    expect(isFencedGrant({ permissions: ["entity.read"] })).toBe(true);
    expect(isFencedGrant({ permissions: [] })).toBe(true); // deny-all
    expect(isFencedGrant({ permissions: ["*"] })).toBe(false);
    expect(isFencedGrant(null)).toBe(false);
  });
});

describe("restDoorAllowed", () => {
  it.each([
    ["GET", "/entities/abc", true],
    ["GET", "/users/u1/entities", true],
    ["GET", "/documents/d1/raw", true],
    ["GET", "/brand/kit", true],
    ["GET", "/search", false],
    ["GET", "/entities", false], // ?q= goes to Typesense — not seamed
    ["GET", "/knowledge", false],
    ["GET", "/compacted-states/latest", false],
    ["POST", "/knowledge/ask", false],
    ["POST", "/entities/retrieve", false],
    ["POST", "/entities", true], // a write — bounded by the gate
    ["PATCH", "/entities/abc", true],
    ["DELETE", "/entities/abc", true],
  ] as const)("%s %s → %s", (method, path, ok) => {
    expect(restDoorAllowed(method, path)).toBe(ok);
  });
});

describe("mcpToolAllowed / trpcProcedureAllowed", () => {
  it("read tools only when seamed; write tools always", () => {
    expect(mcpToolAllowed("synap_get_entities", true)).toBe(true);
    expect(mcpToolAllowed("synap_ask", true)).toBe(false);
    expect(mcpToolAllowed("synap_create_entity", false)).toBe(true);
  });
  it("queries only when seamed; mutations always", () => {
    expect(trpcProcedureAllowed("query", "entities.getEntities")).toBe(true);
    expect(trpcProcedureAllowed("query", "search.search")).toBe(false);
    expect(trpcProcedureAllowed("mutation", "entities.create")).toBe(true);
  });
});
