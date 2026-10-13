/**
 * Hub REST `GET /focus-sessions` — the SUBJECT narrow rides the ONE session
 * WHERE (surfaces W1.1). This door used to push its own private
 * `eq(subjectEntityId)` on top of `sessionListConditions`; it now resolves
 * `subjectEntityId` / `subjectProfileSlug` and hands the subject to the shared
 * builder, so tRPC and Hub REST read the same predicate (subject anchor OR a
 * worker's target edge — its SQL is proven on PGlite in
 * `routers/focus-sessions.subject-filter.pglite.test.ts`).
 *
 * DB-free: `db.select` is a chain stub, the profile lookup is mocked, and
 * `sessionListConditions` is wrapped (real implementation) so the assertion is
 * the subject it RECEIVED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({
  subjects: [] as unknown[],
}));

vi.mock("../../../services/projects/load-visible-project.js", () => ({
  loadVisibleProject: vi.fn(async (_db: unknown, id: string) => ({
    id,
    name: "p",
    workspaceId: null,
    userId: "user-1",
  })),
}));
vi.mock("../../../utils/assert-known-profile-slug.js", async () => {
  const { TRPCError } = await import("@trpc/server");
  return {
    assertKnownProfileSlug: vi.fn(async (_db: unknown, slug: string) => {
      if (slug === "lead")
        return [
          {
            id: "99999999-9999-4999-8999-999999999999",
            profileKind: "kind",
            entityScope: "workspace",
          },
        ];
      throw new TRPCError({ code: "NOT_FOUND", message: `No ${slug}` });
    }),
  };
});
vi.mock(
  "../../../services/focus-sessions/session-list-conditions.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/focus-sessions/session-list-conditions.js")
      >();
    return {
      ...actual,
      sessionListConditions: (
        q: Parameters<typeof actual.sessionListConditions>[0]
      ) => {
        h.subjects.push(q.subject);
        return actual.sessionListConditions(q);
      },
    };
  }
);

import { db } from "@synap/database";
import { registerFocusSessionsRoutes } from "./focus-sessions.js";
import type { HubHono, HubVariables } from "./_shared.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const THING = "22222222-2222-4222-8222-222222222222";

function buildTestApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("/*", async (c, next) => {
    c.set("userId", "user-1");
    c.set("scopes", ["hub-protocol.read"]);
    await next();
  });
  registerFocusSessionsRoutes(app);
  return app;
}

describe("Hub REST GET /focus-sessions — subject", () => {
  let selectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    h.subjects = [];
    const chain = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: async () => [],
    };
    selectSpy = vi.spyOn(db, "select").mockReturnValue(chain as never);
  });
  afterEach(() => selectSpy.mockRestore());

  it("subjectEntityId reaches the one WHERE builder as an entity subject", async () => {
    const res = await buildTestApp().request(
      `/focus-sessions?projectId=${PROJECT}&subjectEntityId=${THING}`
    );
    expect(h.subjects).toEqual([{ kind: "entities", entityIds: [THING] }]);
    expect(res.status).toBe(200);
  });

  it("subjectProfileSlug resolves through the board's rule", async () => {
    const res = await buildTestApp().request(
      `/focus-sessions?projectId=${PROJECT}&subjectProfileSlug=lead`
    );
    expect(h.subjects).toEqual([
      { kind: "kind", profileIds: ["99999999-9999-4999-8999-999999999999"] },
    ]);
    expect(res.status).toBe(200);
  });

  it("an unknown slug ⇒ 404, no list query", async () => {
    const res = await buildTestApp().request(
      `/focus-sessions?projectId=${PROJECT}&subjectProfileSlug=nope`
    );
    expect(res.status).toBe(404);
    expect(h.subjects).toEqual([]);
  });

  it("both, or a malformed id ⇒ 400", async () => {
    const both = await buildTestApp().request(
      `/focus-sessions?projectId=${PROJECT}&subjectEntityId=${THING}&subjectProfileSlug=lead`
    );
    expect(both.status).toBe(400);
    const bad = await buildTestApp().request(
      `/focus-sessions?projectId=${PROJECT}&subjectEntityId=nope`
    );
    expect(bad.status).toBe(400);
    expect(h.subjects).toEqual([]);
  });
});
