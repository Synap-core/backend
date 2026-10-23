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
  GRANT_DOOR_UNSUPPORTED,
  GRANT_OWNER_WIDE_UNSUPPORTED,
  GRANT_WRITE_DOOR_UNSUPPORTED,
  isFencedGrant,
  isUnboundedFullAccess,
  mcpToolAllowed,
  ownerWideDoorAllowed,
  restDoorAllowed,
  TRPC_KEY_MUTATION_DOORS,
  trpcProcedureAllowed,
  trpcRefusalMessage,
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
  it("fences a `*` pinned to a space, project or object (S1)", () => {
    const pinned = (narrowing: Record<string, string[]>) =>
      ({
        scopes: [{ permissions: ["*"], ...narrowing }],
        clientId: null,
      }) as never;
    expect(isFencedGrant(pinned({ workspaceIds: ["w1"] }))).toBe(true);
    expect(isFencedGrant(pinned({ projectIds: ["p1"] }))).toBe(true);
    expect(isFencedGrant(pinned({ entityIds: ["e1"] }))).toBe(true);
    // One pinned scope beside an unbounded one keeps the key fenced.
    expect(
      isFencedGrant({
        scopes: [
          { permissions: ["*"] },
          { permissions: ["*"], workspaceIds: ["w1"] },
        ],
        clientId: null,
      } as never)
    ).toBe(true);
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
    // The list door: seamed; its ?q= (Typesense) branch is refused by the
    // route itself for a limited key (entities.scoped-key-list.pglite.test.ts).
    ["GET", "/entities", true],
    ["GET", "/entities/", true],
    ["GET", "/knowledge", false],
    ["GET", "/compacted-states/latest", false],
    ["POST", "/knowledge/ask", false],
    ["POST", "/entities/retrieve", false],
    ["POST", "/entities", true], // a write — bounded by the gate
    // Seamed: the standing read floors its answer by the grant (fence1).
    ["POST", "/workspaces/ensure-template", true],
    ["PATCH", "/entities/abc", true],
    ["DELETE", "/entities/abc", true],
  ] as const)("%s %s → %s", (method, path, ok) => {
    expect(restDoorAllowed(method, path, DOC_ONLY)).toBe(ok);
  });
});

describe("self-introspection doors", () => {
  // A computer / agent key from the device flow carries the AI preset; it must
  // still learn who it is (2026-10-11: Claude Code's installer got 403 here).
  const denyAll = key({ permissions: [] });
  it.each(["/users/me", "/auth/status"])(
    "GET %s is open to every scoped key",
    (path) => {
      for (const grant of [AI, DOC_ONLY, denyAll]) {
        expect(restDoorAllowed("GET", path, grant)).toBe(true);
      }
    }
  );
  it("is exact: another user's record is not self", () => {
    expect(restDoorAllowed("GET", "/users/someone-else", AI)).toBe(false);
  });
});

describe("mcpToolAllowed", () => {
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
});

describe("trpcProcedureAllowed (S7: the Bearer tRPC door fences mutations)", () => {
  const FULL = key({ permissions: ["*"] });
  const STAR_ONE_WS = key({ permissions: ["*"], workspaceIds: ["w1"] });
  const GATED = "documents.patchDocument"; // (a) the gate bounds it
  const OWNER_WIDE = "services.register"; // (b)
  // A row still refused (class c/d), read from the table so the example
  // follows the W2 flips; once none is left, the unclassified path stands in.
  const REFUSED =
    Object.entries(TRPC_KEY_MUTATION_DOORS).find(
      ([, door]) => door.bound === "refused"
    )?.[0] ?? "entities.someOtherNewMutation";
  const UNCLASSIFIED = "entities.someNewMutation";

  it("queries: a scoped key only when seamed; an unfenced key always", () => {
    expect(trpcProcedureAllowed("query", "entities.getEntities", AI)).toBe(
      true
    );
    expect(trpcProcedureAllowed("query", "search.search", AI)).toBe(false);
    expect(trpcProcedureAllowed("query", "search.search", FULL)).toBe(true);
    // S1: a `*` pinned to a space is a scoped key.
    expect(trpcProcedureAllowed("query", "search.search", STAR_ONE_WS)).toBe(
      false
    );
  });

  it("a scoped key passes a GATED mutation and nothing else", () => {
    for (const grant of [AI, DOC_ONLY]) {
      expect(trpcProcedureAllowed("mutation", GATED, grant)).toBe(true);
      expect(trpcProcedureAllowed("mutation", OWNER_WIDE, grant)).toBe(false);
      expect(trpcProcedureAllowed("mutation", REFUSED, grant)).toBe(false);
      // Fail closed: a mutation nobody classified is refused.
      expect(trpcProcedureAllowed("mutation", UNCLASSIFIED, grant)).toBe(false);
    }
  });

  it("a deny-all key still reaches a GATED mutation (the gate denies it)", () => {
    const denyAll = key({ permissions: [] });
    expect(trpcProcedureAllowed("mutation", GATED, denyAll)).toBe(true);
    expect(trpcProcedureAllowed("mutation", REFUSED, denyAll)).toBe(false);
  });

  it("an unbounded `*` key passes every mutation, classified or not", () => {
    for (const path of [GATED, OWNER_WIDE, REFUSED, UNCLASSIFIED]) {
      expect(trpcProcedureAllowed("mutation", path, FULL)).toBe(true);
    }
  });

  it("a `*` pinned to a workspace is a scoped key: GATED only", () => {
    expect(trpcProcedureAllowed("mutation", GATED, STAR_ONE_WS)).toBe(true);
    expect(trpcProcedureAllowed("mutation", OWNER_WIDE, STAR_ONE_WS)).toBe(
      false
    );
    expect(trpcProcedureAllowed("mutation", REFUSED, STAR_ONE_WS)).toBe(false);
    expect(trpcProcedureAllowed("mutation", UNCLASSIFIED, STAR_ONE_WS)).toBe(
      false
    );
  });

  it("no grant (legacy key, session) passes everything, as before", () => {
    for (const path of [GATED, OWNER_WIDE, REFUSED, UNCLASSIFIED]) {
      expect(trpcProcedureAllowed("mutation", path, null)).toBe(true);
      expect(trpcProcedureAllowed("mutation", path, undefined)).toBe(true);
    }
    expect(trpcProcedureAllowed("query", "search.search", null)).toBe(true);
  });

  it("a subscription is judged like a write (fail closed)", () => {
    expect(trpcProcedureAllowed("subscription", "x.onEvent", AI)).toBe(false);
    expect(trpcProcedureAllowed("subscription", "x.onEvent", FULL)).toBe(true);
  });

  it("the ten (d) product-decision mutations are decided: GATED, bounded inside", () => {
    // Founder, 2026-10-20 (plan §2 D1–D5), applied in W2a (D2), W2b (D4) and
    // W2d (D1, D3, D5): each door bounds the key itself.
    for (const path of [
      "automations.createAutomation",
      "automations.updateAutomation",
      "automations.activateAutomation",
      "automations.triggerAutomation",
      "entities.attachFacet",
      "entities.updateFacet",
      "entities.detachFacet",
      "proposals.updateProposal",
      "channels.triggerAI",
      "observations.append",
    ]) {
      expect(TRPC_KEY_MUTATION_DOORS[path]?.bound, path).toBe("gated");
      expect(trpcProcedureAllowed("mutation", path, AI), path).toBe(true);
    }
  });

  it("names the refusal: owner-wide doors say so, the rest is unsupported", () => {
    expect(trpcRefusalMessage("mutation", OWNER_WIDE)).toBe(
      GRANT_OWNER_WIDE_UNSUPPORTED
    );
    expect(trpcRefusalMessage("mutation", REFUSED)).toBe(
      GRANT_WRITE_DOOR_UNSUPPORTED
    );
    expect(trpcRefusalMessage("mutation", UNCLASSIFIED)).toBe(
      GRANT_WRITE_DOOR_UNSUPPORTED
    );
    expect(trpcRefusalMessage("query", "search.search")).toBe(
      GRANT_DOOR_UNSUPPORTED
    );
  });
});

describe("owner-wide doors (webhooks)", () => {
  const FULL = key({ permissions: ["*"] });
  const STAR_ONE_WS = key({ permissions: ["*"], workspaceIds: ["w1"] });
  const STAR_ONE_PROJECT = key({ permissions: ["*"], projectIds: ["p1"] });
  it("unbounded = every scope `*` with no narrowing", () => {
    expect(isUnboundedFullAccess(FULL)).toBe(true);
    expect(isUnboundedFullAccess(STAR_ONE_WS)).toBe(false);
    expect(isUnboundedFullAccess(STAR_ONE_PROJECT)).toBe(false);
    expect(isUnboundedFullAccess(AI)).toBe(false);
    // S1: a pinned `*` is narrowed, so the scoped-key fence applies too.
    expect(isFencedGrant(STAR_ONE_WS)).toBe(true);
    expect(isFencedGrant(STAR_ONE_PROJECT)).toBe(true);
  });
  it.each([
    // S2/D7: a subscription is bound to its key and delivers by its grant.
    ["/webhooks", false],
    ["/webhooks/", false],
    ["/webhooks/abc", false],
    // The delivery log is still read by owner only.
    ["/webhooks/abc/deliveries", true],
    ["/webhooksx", false],
    ["/calendar/feed", true],
    ["/calendar/feed/rotate", true],
    // The credentialless .ics read skips auth — no grant ever reaches it.
    ["/calendar/feed/abcdef.ics", false],
    ["/agents/sync", true],
    ["/agents", false],
    ["/entities", false],
  ] as const)("%s is owner-wide → %s", (path, ownerWide) => {
    expect(ownerWideDoorAllowed(path, STAR_ONE_WS)).toBe(!ownerWide);
    expect(ownerWideDoorAllowed(path, DOC_ONLY)).toBe(!ownerWide);
    expect(ownerWideDoorAllowed(path, FULL)).toBe(true);
    // A signed-in session carries no grant.
    expect(ownerWideDoorAllowed(path, null)).toBe(true);
  });
});

describe("webhooks for a scoped key (S2/D7)", () => {
  const DOC_ONLY_WS = key({
    permissions: ["document.read"],
    workspaceIds: ["w1"],
  });
  it("may list its own subscriptions (a safe read) and create / delete (writes)", () => {
    expect(restDoorAllowed("GET", "/webhooks", DOC_ONLY_WS)).toBe(true);
    expect(restDoorAllowed("POST", "/webhooks", DOC_ONLY_WS)).toBe(true);
    expect(restDoorAllowed("DELETE", "/webhooks/abc", DOC_ONLY_WS)).toBe(true);
    expect(ownerWideDoorAllowed("/webhooks", DOC_ONLY_WS, "POST")).toBe(true);
  });
  it("still may not read the owner's delivery log", () => {
    expect(
      restDoorAllowed("GET", "/webhooks/abc/deliveries", DOC_ONLY_WS)
    ).toBe(false);
    expect(
      ownerWideDoorAllowed("/webhooks/abc/deliveries", DOC_ONLY_WS, "GET")
    ).toBe(false);
  });
});
