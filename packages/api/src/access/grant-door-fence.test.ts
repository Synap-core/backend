/**
 * The scoped-key door fence (W1). Rows rule out: a fence that only checks GET
 * (POST reads leak), one that blocks writes (gate already bounds them), one
 * that blocks the seamed reads a site needs, and a full-access key fenced.
 */
import { describe, expect, it } from "vitest";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";
import {
  isFencedGrant,
  mcpToolAllowed,
  restDoorAllowed,
  trpcProcedureAllowed,
} from "./grant-door-fence.js";

describe("isFencedGrant", () => {
  it("fences a narrow grant, never a legacy key or the explicit '*'", () => {
    const g = (...scopes: string[][]) => ({
      scopes: scopes.map((permissions) => ({ permissions })),
      clientId: null,
    });
    expect(isFencedGrant(g(["entity.read"]))).toBe(true);
    expect(isFencedGrant(g([]))).toBe(true); // deny-all
    expect(isFencedGrant(g(["*"]))).toBe(false);
    // A key is unfenced only when EVERY scope is full access.
    expect(isFencedGrant(g(["*"], ["entity.read"]))).toBe(true);
    expect(isFencedGrant(null)).toBe(false);
  });
});

const key = (...scopes: Array<Record<string, unknown>>) =>
  ({ scopes, clientId: null }) as never;
const AI = key({
  permissions: GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!
    .grant.permissions,
});
const DOC_ONLY = key({ permissions: ["document.read"] });

describe("restDoorAllowed", () => {
  it.each([
    ["GET", "/entities/abc", true],
    ["GET", "/users/u1/entities", true],
    ["GET", "/documents/d1/raw", true],
    ["GET", "/brand/kit", true],
    ["GET", "/threads/t1/messages", true],
    ["GET", "/focus-sessions", true],
    ["GET", "/focus-sessions/s1", false], // owner-only read, not the helper
    ["GET", "/projects/p1", true],
    ["GET", "/projects/p1/path", false], // userVisibleWhere sessions — not migrated
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
    expect(restDoorAllowed(method, path, DOC_ONLY)).toBe(ok);
  });
});

describe("mcpToolAllowed / trpcProcedureAllowed", () => {
  it("read tools only when seamed; write tools always", () => {
    expect(mcpToolAllowed("synap_get_entities", true, DOC_ONLY)).toBe(true);
    expect(mcpToolAllowed("synap_ask", true, DOC_ONLY)).toBe(false);
    expect(mcpToolAllowed("synap_create_entity", false, DOC_ONLY)).toBe(true);
    expect(mcpToolAllowed("synap_not_classified", true, AI)).toBe(false);
  });
  it.each([
    "synap_ask",
    "synap_orient",
    "synap_find",
    "synap_get_entity",
    "synap_list_sessions",
  ])("the AI preset may call %s", (tool) => {
    expect(mcpToolAllowed(tool, true, AI)).toBe(true);
  });
  it("an aggregate door needs EVERY subject it reads, unnarrowed", () => {
    // document.read alone does not read the entities ask returns.
    expect(mcpToolAllowed("synap_ask", true, DOC_ONLY)).toBe(false);
    // Every subject, but only one kind of entity: ask cannot narrow to it.
    const oneKind = key({
      permissions: [
        "entity.note.read",
        "document.read",
        "relation.read",
        "proposal.read",
        "preference.read",
        "project.read",
      ],
    });
    expect(mcpToolAllowed("synap_ask", true, oneKind)).toBe(false);
    // Every subject, but narrowed to one workspace: refused.
    const ai = GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!
      .grant.permissions;
    expect(
      mcpToolAllowed(
        "synap_ask",
        true,
        key({ permissions: ai, workspaceIds: ["w1"] })
      )
    ).toBe(false);
    // The same scope beside an unnarrowed one passes (any ONE scope suffices).
    expect(
      mcpToolAllowed(
        "synap_ask",
        true,
        key({ permissions: ai, workspaceIds: ["w1"] }, { permissions: ai })
      )
    ).toBe(true);
    expect(mcpToolAllowed("synap_diagnose", true, AI)).toBe(false);
  });
  it("a deny-all key passes no declared door, even one that reads no subject", () => {
    const denyAll = key({ permissions: [] });
    expect(mcpToolAllowed("synap_load_skill", true, denyAll)).toBe(false);
    expect(mcpToolAllowed("synap_ask", true, denyAll)).toBe(false);
    expect(restDoorAllowed("POST", "/knowledge/ask", denyAll)).toBe(false);
    expect(mcpToolAllowed("synap_load_skill", true, DOC_ONLY)).toBe(true);
    expect(mcpToolAllowed("synap_load_skill", true, AI)).toBe(true);
  });
  it("hub POST reads follow the same declaration", () => {
    expect(restDoorAllowed("POST", "/knowledge/ask", AI)).toBe(true);
    expect(restDoorAllowed("POST", "/knowledge/ask", DOC_ONLY)).toBe(false);
    expect(restDoorAllowed("POST", "/diagnose", AI)).toBe(false);
    expect(restDoorAllowed("POST", "/capabilities/execute", AI)).toBe(false);
  });
  it("queries only when seamed; mutations always", () => {
    expect(trpcProcedureAllowed("query", "entities.getEntities")).toBe(true);
    expect(trpcProcedureAllowed("query", "search.search")).toBe(false);
    expect(trpcProcedureAllowed("mutation", "entities.create")).toBe(true);
  });
});
