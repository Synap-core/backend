/**
 * market.scaffold — the SEAM test.
 *
 * Drives the REAL registered handler through the REAL skeleton generator into a
 * mocked `entitiesRouter.create`, so nothing between the verb name and the
 * governed door is hand-built. Four properties matter:
 *
 *   1. the skeleton actually REACHES the door as `content` (mutation target:
 *      break that forwarding and this goes red),
 *   2. it is created as a `document` ENTITY (not a bare documents row) so the
 *      graph, `ask` and the project ladder can see it,
 *   3. a `proposed` verdict is surfaced as SUCCESS with a review url, and
 *   4. the body does NOT come back to the caller — the return is an id + url +
 *      a one-line summary, per "send back the URL/id and not the full content".
 *
 * It does NOT mock `@synap/database`: the seven sibling `builtin-verbs-*.test.ts`
 * files fail at COLLECTION on an incomplete `@synap/database` mock factory, and
 * this file deliberately avoids that trap (the module imports fine unmocked —
 * `catalog-schema-coherence.tripwire.test.ts` proves it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();
vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: { createCaller: () => ({ create: createMock }) },
}));

import {
  BUILTIN_VERBS,
  BUILTIN_VERB_PARAM_SCHEMAS,
  READ_ONLY_BUILTIN_VERBS,
} from "./builtin-verbs.js";
import { buildPackageSkeleton } from "./market-scaffold.js";

const ENTITY_ID = "11111111-2222-3333-4444-555555555555";
const PROPOSAL_ID = "99999999-8888-7777-6666-555555555555";
const ctx = { userId: "user-1", workspaceId: null };

function createdReply() {
  return {
    status: "created" as const,
    message: "Entity created",
    id: ENTITY_ID,
    entity: { id: ENTITY_ID },
    facets: [],
  };
}

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue(createdReply());
});

describe("market.scaffold", () => {
  it("NON-VACUITY: the verb is registered, schema'd, and is a WRITE", () => {
    expect(BUILTIN_VERBS["market.scaffold"]).toBeTypeOf("function");
    expect(BUILTIN_VERB_PARAM_SCHEMAS["market.scaffold"]).toBeDefined();
    // A write must flow through the full capability gate.
    expect(READ_ONLY_BUILTIN_VERBS.has("market.scaffold")).toBe(false);
    // The skeleton it forwards is substantial, so "did the body arrive"
    // is a question with a real answer.
    expect(
      buildPackageSkeleton("book-club", "workspace").body.length
    ).toBeGreaterThan(200);
  });

  it("forwards the FULL skeleton body to entities.create as a `document` entity", async () => {
    const expected = buildPackageSkeleton("book-club", "workspace");
    await BUILTIN_VERBS["market.scaffold"]({ slug: "book-club" }, ctx);

    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.content).toBe(expected.body);
    expect(arg.title).toBe(expected.title);
    // The KIND. An existing pod kind, never a minted twin.
    expect(arg.profileSlug).toBe("document");
    // The `document` kind models ZERO properties, so a bag would be stored
    // unmodeled and be invisible to a schema-driven UI. None is sent.
    expect(arg.properties).toBeUndefined();
  });

  it("passes an explicit projectId through, and sends none when omitted", async () => {
    const projectId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await BUILTIN_VERBS["market.scaffold"](
      { slug: "book-club", projectId },
      ctx
    );
    expect(
      (createMock.mock.calls[0][0] as Record<string, unknown>).projectId
    ).toBe(projectId);

    createMock.mockClear();
    await BUILTIN_VERBS["market.scaffold"]({ slug: "book-club" }, ctx);
    // Absent, NOT null: the door's own placement ladder must be free to resolve
    // one (producing session → agent focus). No relation is hand-rolled here.
    expect(
      createMock.mock.calls[0][0] as Record<string, unknown>
    ).not.toHaveProperty("projectId");
  });

  it("governs an AGENT run as an agent (forwards agentUserId)", async () => {
    const agentUserId = "cccccccc-dddd-eeee-ffff-000000000000";
    await BUILTIN_VERBS["market.scaffold"](
      { slug: "book-club" },
      { ...ctx, agentUserId }
    );
    expect(
      (createMock.mock.calls[0][0] as Record<string, unknown>).agentUserId
    ).toBe(agentUserId);
  });

  it("returns an id + url + summary and NOT the definition body", async () => {
    const expected = buildPackageSkeleton("book-club", "workspace");
    const out = (await BUILTIN_VERBS["market.scaffold"](
      { slug: "book-club" },
      ctx
    )) as Record<string, unknown>;

    expect(out.status).toBe("created");
    expect(out.entityId).toBe(ENTITY_ID);
    expect(String(out.url)).toContain(ENTITY_ID);
    expect(out.slug).toBe("book-club");
    expect(out.category).toBe("workspace");
    expect(out.fileName).toBe("book-club.template.yaml");
    // The body is NOT in the response — assert on a distinctive fragment of it
    // rather than on key names, so adding a key cannot smuggle it back in.
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("profiles:");
    expect(wire).not.toContain(expected.body);
    expect(wire.length).toBeLessThan(expected.body.length + 200);
  });

  it("surfaces a PROPOSED verdict as success, with the door's review url", async () => {
    const expected = buildPackageSkeleton("book-club", "workspace");
    createMock.mockResolvedValue({
      status: "proposed",
      message: "Entity creation proposed for review",
      entity: null,
      proposalId: PROPOSAL_ID,
      proposalType: "entity.create",
      reviewUrl: `https://pod.example/open/${PROPOSAL_ID}`,
      proposedEntityId: ENTITY_ID,
    });

    const out = (await BUILTIN_VERBS["market.scaffold"](
      { slug: "book-club" },
      ctx
    )) as Record<string, unknown>;

    // Verbatim from the door — never rewritten into an error or a fake success.
    expect(out.status).toBe("proposed");
    expect(out.proposalId).toBe(PROPOSAL_ID);
    expect(out.entityId).toBe(ENTITY_ID);
    expect(out.url).toBe(`https://pod.example/open/${PROPOSAL_ID}`);
    // Still no body on the wire, on this path too.
    expect(JSON.stringify(out)).not.toContain(expected.body);
  });

  it("scaffolds a standalone package for a non-workspace category", async () => {
    await BUILTIN_VERBS["market.scaffold"](
      { slug: "book-club", category: "cell" },
      ctx
    );
    const arg = createMock.mock.calls[0][0] as { content: string };
    expect(JSON.parse(arg.content).definition.cells[0].contentKind).toBe(
      "widget"
    );
  });

  it("refuses category:'skill' WITH the Control-Plane reason", async () => {
    await expect(
      BUILTIN_VERBS["market.scaffold"](
        { slug: "book-club", category: "skill" },
        ctx
      )
    ).rejects.toThrow(/no standalone slot/i);
    expect(createMock).not.toHaveBeenCalled();
  });
});
