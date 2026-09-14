import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A1 BEYOND CAPTURE: an MCP write through a NON-capture hub door must not take
 * its project from a GUESSED session.
 *
 * The derived session reaches ~356 `checkPermissionOrPropose` call sites and
 * `entities/create.ts:915` as a plain `ctx.sessionId`, with no source attached.
 * The carrier is the request write context: the MCP adapter enters
 * `runWithDerivedSession` ONLY when attribution is `derived`, and the one project
 * ladder treats `sessionId === derivedSessionId` as derived.
 *
 * Driven through the REAL `executeMCPToolViaHubProtocol` → REAL
 * `resolveSessionHandle` (ownership check + open-session read, db mocked at
 * `@synap/database`). The `synap_create_entity` handler is stubbed to do what
 * `entities/create.ts:915` does — call the REAL `resolveProjectPlacement` with
 * `ctx.sessionId` and no source — over a fake executor whose session row IS
 * project-scoped, so every row discriminates on `projectId`.
 *
 * DISCRIMINATING ROW (orchestrator): an EXPLICIT `sessionId` equal to the id that
 * is ALSO the newest open session. The caller named it, so it must place — a
 * carrier keyed on "is this the newest session" instead of "was it guessed"
 * would wrongly strip it.
 *
 * COVERAGE BOUNDARY: the stub stands in for the create door's ladder call; it
 * does not run `entities.create` itself (DB-backed). Needs the @synap/database
 * dist with the request-write-context accessors + ladder read.
 */

const S_NEWEST = "11111111-1111-4111-8111-111111111111";
const S_OLDER = "22222222-2222-4222-8222-222222222222";
const S_EXPLICIT = "33333333-3333-4333-8333-333333333333";
const P_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const h = vi.hoisted(() => ({
  owned: false,
  openRows: [] as Array<{ id: string }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: vi.fn(async () => ({})),
    db: {
      select: vi.fn((columns: Record<string, unknown>) => {
        const isOpenList = "goal" in columns;
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.limit = async () =>
          isOpenList
            ? h.openRows.map((r) => ({ ...r, goal: null, startedAt: null }))
            : h.owned
              ? [{ id: "owned" }]
              : [];
        return chain;
      }),
    },
  };
});

vi.mock("../handlers/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handlers/shared.js")>();
  return { ...actual, createHubProtocolCaller: vi.fn(async () => ({})) };
});

vi.mock("../handlers/entity.js", async () => {
  const database = await import("@synap/database");
  const fakeExecutor = {
    query: {
      focusSessions: { findFirst: async () => ({ projectId: P_SESSION }) },
      channels: { findFirst: async () => undefined },
      relations: { findMany: async () => [] },
    },
  };
  return {
    entityHandlers: {
      synap_create_entity: async (ctx: {
        userId: string;
        sessionId?: string;
      }) => {
        // What `entities/create.ts:915` passes: the ctx session, NO source.
        const placement = await database.resolveProjectPlacement(
          fakeExecutor as never,
          { userId: ctx.userId, sessionId: ctx.sessionId }
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionId: ctx.sessionId ?? null,
                projectId: placement.projectId,
                derivedSessionId: database.getDerivedSessionId() ?? null,
              }),
            },
          ],
        };
      },
    },
  };
});

const { executeMCPToolViaHubProtocol } = await import("../adapter.js");

async function createEntity(args: Record<string, unknown>) {
  const result = await executeMCPToolViaHubProtocol(
    "synap_create_entity",
    { profileSlug: "note", title: "x", ...args },
    "user-1",
    ["mcp.write"]
  );
  const blocks = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(blocks[0].text) as {
    sessionId: string | null;
    projectId: string | null;
    derivedSessionId: string | null;
    attribution: { session: string };
  };
}

beforeEach(() => {
  h.owned = false;
  h.openRows = [];
});

describe("A1 — a non-capture MCP hub door never takes a project from a guessed session", () => {
  it("DERIVED newest session: the write is grouped under it but gets NO project", async () => {
    h.openRows = [{ id: S_NEWEST }, { id: S_OLDER }];

    const out = await createEntity({});

    expect(out.attribution.session).toBe("derived");
    expect(out.sessionId).toBe(S_NEWEST);
    expect(out.derivedSessionId).toBe(S_NEWEST);
    expect(out.projectId).toBeNull();
  });

  it("a DIFFERENT explicit owned session still places the write", async () => {
    h.owned = true;
    h.openRows = [{ id: S_NEWEST }, { id: S_OLDER }];

    const out = await createEntity({ sessionId: S_EXPLICIT });

    expect(out.attribution.session).toBe("explicit");
    expect(out.derivedSessionId).toBeNull();
    expect(out.projectId).toBe(P_SESSION);
  });

  it("DISCRIMINATING: an explicit sessionId that is ALSO the newest open session still places", async () => {
    h.owned = true;
    h.openRows = [{ id: S_NEWEST }, { id: S_OLDER }];

    const out = await createEntity({ sessionId: S_NEWEST });

    expect(out.attribution.session).toBe("explicit");
    expect(out.derivedSessionId).toBeNull();
    expect(out.projectId).toBe(P_SESSION);
  });
});
