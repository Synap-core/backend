/**
 * Focused authz: token A must not emit B's events.
 *
 * The feed looks up the token hash, then reads through
 * `entityReadVisibleWhere(tokenOwner)` — never a bare userVisibleWhere.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../../../utils/share-token.js";

const { findFirstMock, whereMock, updateWhereMock, entityReadVisibleWhereSpy } =
  vi.hoisted(() => ({
    findFirstMock: vi.fn(),
    whereMock: vi.fn(),
    updateWhereMock: vi.fn(),
    entityReadVisibleWhereSpy: vi.fn(),
  }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.innerJoin = () => selectChain;
  // The read ends `.where(...).orderBy(...).limit(n)`. Keep the chain honest:
  // `where` records the predicate, and the AWAITED value comes from the end of
  // the chain — otherwise adding a LIMIT silently turns every row list empty.
  selectChain.where = (...args: unknown[]) => {
    const rows = whereMock(...args);
    return {
      orderBy: () => ({ limit: () => rows }),
    };
  };
  // Only the FEED's own read is intercepted. Everything else that calls
  // `db.select()` inside this handler — the access floor's membership
  // subqueries, the google external-link subquery — must reach the REAL
  // drizzle builder, or `inArray(col, <plain mock object>)` compiles to
  // garbage and the predicate this suite inspects would be fiction. The
  // discriminator is the feed projection's own `preview` column.
  const isFeedProjection = (cols: unknown) =>
    !!cols && typeof cols === "object" && "preview" in (cols as object);
  return {
    ...actual,
    calendarFeedTokens: actual.calendarFeedTokens ?? {
      id: "cft.id",
      userId: "cft.userId",
      tokenLookupHash: "cft.hash",
      tokenPrefix: "cft.prefix",
      createdAt: "cft.created",
      lastAccessedAt: "cft.accessed",
      revokedAt: "cft.revoked",
    },
    db: {
      query: {
        calendarFeedTokens: { findFirst: findFirstMock },
      },
      select: (cols?: unknown) =>
        isFeedProjection(cols)
          ? selectChain
          : (actual.db.select as (c?: never) => unknown)(cols as never),
      update: () => ({
        set: () => ({
          where: (...args: unknown[]) => updateWhereMock(...args),
        }),
      }),
      insert: () => ({ values: vi.fn() }),
    },
  };
});

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
});

vi.mock("../../entities/helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../entities/helpers.js")>();
  return {
    ...actual,
    entityReadVisibleWhere: (userId: string) => {
      entityReadVisibleWhereSpy(userId);
      return actual.entityReadVisibleWhere(userId);
    },
  };
});

const { registerCalendarFeedRoutes } = await import("./calendar-feed.js");
import type { HubHono, HubVariables } from "./_shared.js";

/** Inside the -30d/+365d feed window, whenever the suite runs. */
const SOON = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

const USER_A = "user-a";
const USER_B = "user-b";
const TOKEN_A = "token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function buildApp(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  registerCalendarFeedRoutes(app);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateWhereMock.mockResolvedValue(undefined);
  whereMock.mockImplementation(() => Promise.resolve([]));
});

describe("GET /calendar/feed/:token.ics — token isolation", () => {
  it("looks up by hash and reads through entityReadVisibleWhere of the token owner", async () => {
    findFirstMock.mockResolvedValue({
      id: "feed-a",
      userId: USER_A,
      tokenLookupHash: hashToken(TOKEN_A),
      tokenPrefix: TOKEN_A.slice(0, 8),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      lastAccessedAt: null,
      revokedAt: null,
    });
    whereMock.mockImplementation(() =>
      Promise.resolve([
        {
          id: "entity-a",
          title: "Alice deadline",
          preview: null,
          properties: { dueDate: SOON },
          type: "task",
          profileSlug: "task",
          updatedAt: new Date("2026-07-20T00:00:00.000Z"),
        },
      ])
    );

    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain("Alice deadline");
    expect(body).not.toContain("Bob meeting");
    expect(entityReadVisibleWhereSpy).toHaveBeenCalledWith(USER_A);
    expect(entityReadVisibleWhereSpy).not.toHaveBeenCalledWith(USER_B);
  });

  it("does not emit B's events when the query is asked with A's token", async () => {
    findFirstMock.mockResolvedValue({
      id: "feed-a",
      userId: USER_A,
      tokenLookupHash: hashToken(TOKEN_A),
      revokedAt: null,
      createdAt: new Date(),
      tokenPrefix: "token-aa",
    });
    // Simulate the visibility floor: only A's row comes back.
    whereMock.mockImplementation(() =>
      Promise.resolve([
        {
          id: "entity-a",
          title: "Only Alice",
          preview: null,
          properties: { dueDate: SOON },
          type: "task",
          profileSlug: "task",
          updatedAt: new Date(),
        },
      ])
    );

    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    const body = await res.text();
    expect(body).toContain("Only Alice");
    expect(body).not.toContain("Bob");
    expect(
      entityReadVisibleWhereSpy.mock.calls.every((c) => c[0] === USER_A)
    ).toBe(true);
  });

  it("404s an unknown or revoked token without querying entities", async () => {
    findFirstMock.mockResolvedValue(null);
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_B}.ics`);
    expect(res.status).toBe(404);
    expect(whereMock).not.toHaveBeenCalled();
    expect(entityReadVisibleWhereSpy).not.toHaveBeenCalled();
  });

  it("404s a revoked token", async () => {
    findFirstMock.mockResolvedValue({
      id: "feed-a",
      userId: USER_A,
      tokenLookupHash: hashToken(TOKEN_A),
      revokedAt: new Date(),
    });
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(res.status).toBe(404);
    expect(whereMock).not.toHaveBeenCalled();
  });
});

/**
 * THE AUTH SKIP, THROUGH THE REAL MIDDLEWARE.
 *
 * The tests above build a bare app and never mount `hubAuthMiddleware`, so
 * every one of them stays green if the `.endsWith(".ics")` conjunct is deleted
 * from `_middleware/auth.ts` — the change that would open MINT and ROTATE to
 * anonymous callers. That is the single most dangerous edit anyone can make to
 * this feature, and until now no test could see it.
 *
 * So this block mounts the real middleware and asserts the BOUNDARY: the `.ics`
 * read passes without a credential, and the mint/rotate/revoke doors beside it
 * do not.
 *
 * Negative control (verified when written): remove `&& rel.endsWith(".ics")`
 * from auth.ts and "mint is NOT anonymous" goes red. Remove the whole conjunct
 * and "the .ics read is anonymous" goes red instead.
 */
describe("the unauth skip covers ONLY the .ics read", () => {
  const authed: string[] = [];

  async function appWithRealAuth() {
    const { hubAuthMiddleware } = await import("../_middleware/auth.js");
    const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    // Record whichever requests reach authentication, then stop them there —
    // we are testing the SKIP decision, not the credential check itself.
    app.use("*", async (c, next) => {
      const before = c.req.path;
      let reached = true;
      const res = await hubAuthMiddleware(c, async () => {
        reached = false; // skipped auth entirely
        await next();
      });
      if (reached) authed.push(before);
      return res;
    });
    registerCalendarFeedRoutes(app);
    return app;
  }

  beforeEach(() => {
    authed.length = 0;
    findFirstMock.mockResolvedValue(null);
  });

  it("the .ics read is anonymous (no Authorization header, not 401)", async () => {
    const app = await appWithRealAuth();
    const res = await app.request(`/api/hub/calendar/feed/${TOKEN_A}.ics`);
    // 404 because findFirst is null — what matters is that it REACHED the
    // handler rather than being turned away by auth.
    expect(res.status).toBe(404);
    expect(authed).toHaveLength(0);
  });

  it("mint is NOT anonymous", async () => {
    const app = await appWithRealAuth();
    const res = await app.request("/api/hub/calendar/feed", {
      method: "POST",
    });
    expect(res.status).not.toBe(200);
    expect(authed).toEqual(["/api/hub/calendar/feed"]);
  });

  it("rotate is NOT anonymous", async () => {
    const app = await appWithRealAuth();
    const res = await app.request("/api/hub/calendar/feed/rotate", {
      method: "POST",
    });
    expect(res.status).not.toBe(200);
    expect(authed).toEqual(["/api/hub/calendar/feed/rotate"]);
  });

  it("revoke is NOT anonymous", async () => {
    const app = await appWithRealAuth();
    const res = await app.request("/api/hub/calendar/feed", {
      method: "DELETE",
    });
    expect(res.status).not.toBe(200);
    expect(authed).toEqual(["/api/hub/calendar/feed"]);
  });

  it("a path that merely CONTAINS /calendar/feed/ is not anonymous", async () => {
    const app = await appWithRealAuth();
    await app.request("/api/hub/calendar/feed/rotate.ics.json");
    expect(authed).toEqual(["/api/hub/calendar/feed/rotate.ics.json"]);
  });
});

/**
 * Mint/rotate/revoke are the HUMAN's doors.
 *
 * An agent key carries `hub-protocol.write`, so scope alone let it issue a
 * permanent unauthenticated read URL for its owner — or rotate, silently
 * killing the owner's real subscription. The plaintext is returned once,
 * synchronously, so this cannot route through propose: approving would hand
 * the secret to the agent. Hard reject, same shape as `rejectAgentReviewer`.
 */
describe("an agent credential cannot change the feed", () => {
  function appAs(vars: Partial<HubVariables>): HubHono {
    const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
    app.use("*", async (c, next) => {
      c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
      c.set("userId", USER_A);
      for (const [k, v] of Object.entries(vars)) {
        c.set(k as keyof HubVariables, v as never);
      }
      await next();
    });
    registerCalendarFeedRoutes(app);
    return app;
  }

  const doors: Array<[string, string]> = [
    ["POST", "/calendar/feed"],
    ["POST", "/calendar/feed/rotate"],
    ["DELETE", "/calendar/feed"],
  ];

  it.each(doors)("403s %s %s for an agent credential", async (method, path) => {
    findFirstMock.mockResolvedValue(null);
    const app = appAs({ agentUserId: "agent-9" });
    const res = await app.request(path, { method });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/agent credential cannot/i);
  });

  it("a human session still reaches the handler", async () => {
    findFirstMock.mockResolvedValue(null);
    const app = appAs({});
    // No live token to revoke: 200 { revoked: false }, i.e. it got THROUGH.
    const res = await app.request("/calendar/feed", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false });
  });

  it("revoke writes revokedAt — the feed can actually be turned off", async () => {
    findFirstMock.mockResolvedValue({
      id: "feed-a",
      userId: USER_A,
      tokenLookupHash: hashToken(TOKEN_A),
      tokenPrefix: "token-aa",
      createdAt: new Date(),
      revokedAt: null,
    });
    const app = appAs({});
    const res = await app.request("/calendar/feed", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    // Reachability: the UPDATE actually ran. Before this door existed,
    // `revokedAt` was only ever written null and the reader's revoked branch
    // was unreachable code.
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE READ PREDICATE ITSELF — ownership, and the Google exclusion.
 *
 * The suite above mocks `db`, so no row is ever actually filtered: `whereMock`
 * hands back whatever the fixture says regardless of the predicate. Asserting
 * "B's row did not come back" against that mock would be theatre.
 *
 * So these tests assert the thing that IS real here: the WHERE the handler
 * hands to Postgres. They compile it with `PgDialect` and inspect its
 * TOP-LEVEL conjuncts + bound params — the same technique, and the same
 * justification, as `access/two-user-floor.test.ts` ("the access unit suite
 * runs without a seeded DB; compiling the WHERE proves the floor structurally").
 *
 * TOP-LEVEL is load-bearing, not decoration. The access floor
 * (`entityReadVisibleWhere`) ALSO contains `"entities"."user_id" = $n` bound to
 * the same id, inside its pod-personal branch. A substring match on the whole
 * statement would therefore stay green with the ownership conjunct deleted —
 * a vacuous guard. The floor is one parenthesised `or(...)`, so its copy sits
 * at depth ≥ 2; only the conjunct added here appears at depth 1.
 *
 * WHAT THIS DOES NOT COVER, measured: it proves the predicate reaches the
 * statement with the right binding. It does not execute it — Postgres row
 * semantics (NULL handling in `NOT IN`, index behaviour) are out of scope.
 * `entity_external_links.entity_id` is NOT NULL, which is what makes `NOT IN`
 * safe here.
 */
describe("the feed read predicate — owner-scoped, google-excluded", () => {
  const dialect = new PgDialect();

  /** Drive the real handler once and compile the WHERE it emitted. */
  async function emittedWhere(): Promise<{ sql: string; params: unknown[] }> {
    findFirstMock.mockResolvedValue({
      id: "feed-a",
      userId: USER_A,
      tokenLookupHash: hashToken(TOKEN_A),
      tokenPrefix: "token-aa",
      createdAt: new Date(),
      revokedAt: null,
    });
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(res.status).toBe(200);
    expect(whereMock).toHaveBeenCalledTimes(1);
    const predicate = whereMock.mock.calls[0]![0] as SQL;
    const q = dialect.sqlToQuery(predicate);
    return { sql: q.sql, params: q.params as unknown[] };
  }

  /**
   * The conjuncts of the outermost `and(...)` — i.e. the ones at paren depth 1.
   * Anything nested inside a sub-expression (the floor's own `or(...)`, a
   * subquery) is deliberately invisible here.
   */
  function topLevelConjuncts(sql: string): string[] {
    let s = sql.trim();
    if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (depth === 0 && s.startsWith(" and ", i)) {
        out.push(s.slice(start, i).trim());
        i += 4;
        start = i + 1;
      }
    }
    out.push(s.slice(start).trim());
    return out.filter(Boolean);
  }

  /** The bound value behind a `$n` placeholder inside a conjunct. */
  function boundValue(conjunct: string, params: unknown[]): unknown {
    const m = /\$(\d+)/.exec(conjunct);
    expect(m, `no placeholder in: ${conjunct}`).not.toBeNull();
    return params[Number(m![1]) - 1];
  }

  it("the splitter can see the statement (non-vacuity self-check)", async () => {
    const { sql } = await emittedWhere();
    const parts = topLevelConjuncts(sql);
    // Two conjuncts that predate this change and must always be top-level: if
    // the splitter ever returns one blob (or nothing), every assertion below
    // would pass by never looking at anything.
    expect(parts).toContain('"entities"."deleted_at" is null');
    expect(parts.some((p) => p.startsWith('"profiles"."slug" in ('))).toBe(
      true
    );
    expect(parts.length).toBeGreaterThanOrEqual(4);
  });

  it("narrows to the TOKEN OWNER's own rows — a visible-but-not-owned row cannot match", async () => {
    const { sql, params } = await emittedWhere();
    const owner = topLevelConjuncts(sql).filter((p) =>
      /^"entities"\."user_id" = \$\d+$/.test(p)
    );
    // Exactly one, at the top level — ANDed, so a row owned by anyone else is
    // excluded no matter how widely the floor beneath it can see.
    expect(owner).toHaveLength(1);
    expect(boundValue(owner[0]!, params)).toBe(USER_A);
    expect(params).not.toContain(USER_B);
  });

  it("keeps the access floor — ownership NARROWS it, never replaces it", async () => {
    const { sql } = await emittedWhere();
    // The floor is the one conjunct carrying the workspace-membership union.
    const floor = topLevelConjuncts(sql).filter((p) =>
      p.includes('from "workspace_members"')
    );
    expect(floor).toHaveLength(1);
    expect(entityReadVisibleWhereSpy).toHaveBeenCalledWith(USER_A);
  });

  it("excludes entities that came from Google Calendar", async () => {
    const { sql, params } = await emittedWhere();
    const excl = topLevelConjuncts(sql).filter((p) =>
      p.includes('from "entity_external_links"')
    );
    expect(excl).toHaveLength(1);
    expect(excl[0]).toMatch(/^"entities"\."id" not in \(select /);
    expect(excl[0]).toContain('"entity_external_links"."provider" = $');
    // The provider string the gcal import actually writes. `"google-calendar"`
    // exists only in comments and would match zero rows.
    expect(boundValue(excl[0]!, params)).toBe("google");
  });
});
