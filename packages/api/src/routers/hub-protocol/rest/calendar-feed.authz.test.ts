/**
 * Focused authz: token A must not emit B's events.
 *
 * The feed looks up the token hash, then reads through
 * `entityReadVisibleWhere(tokenOwner)` — never a bare userVisibleWhere.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * THE UID IS A PROPERTY OF THE ITEM, NOT OF THE URL YOU ASKED THROUGH.
 *
 * RFC 5545 §3.8.4.7: a UID identifies the item. The right-hand side used to be
 * `resolvePodHost(host header)`, so a pod reachable at two hostnames emitted
 * two UIDs for one object — which a calendar client reads as delete-plus-
 * create: local colour and alert overrides lost, and a phantom duplicate if
 * both URLs are subscribed.
 *
 * This drives the REAL route and reads the UID out of the REAL body, so it
 * asserts the value that ARRIVES — not that a helper exists. `resolveUidName-
 * space` is module-private on purpose; there is no seam to hand-build past.
 *
 * Negative control (run; the mutation grepped in the source before believing
 * the green/red either way): restore `buildSynapCalendarIcs(visible,
 * resolvePodHost(c.req.header("x-forwarded-host") || c.req.header("host")),
 * …)` and "identical UID across two hostnames" goes RED, printing the two
 * different UIDs; the rest of this file stays green.
 *
 * MEASURED COVERAGE BOUNDARY. Under that same mutation the second case
 * ("uses PUBLIC_URL when set") stays GREEN — `resolvePodHost` also prefers
 * PUBLIC_URL, so the two functions are indistinguishable while it is set. The
 * ONLY discriminating input is a request whose host differs from the
 * configured origin with PUBLIC_URL UNSET; that is why the first case deletes
 * the variable rather than relying on the ambient environment. Do not "tidy"
 * the delete away.
 */
describe("UID does not depend on the hostname the client asked through", () => {
  const ENTITY_ID = "11111111-1111-4111-8111-111111111111";

  function armOneEvent() {
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
          id: ENTITY_ID,
          title: "Deadline",
          preview: null,
          properties: { dueDate: SOON },
          type: "task",
          profileSlug: "task",
          updatedAt: new Date("2026-07-20T00:00:00.000Z"),
        },
      ])
    );
  }

  async function uidVia(host: string): Promise<string> {
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { host },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const uid = /^UID:(.+?)\r?$/m.exec(body)?.[1];
    // Non-vacuity: an empty body would make every equality below trivially
    // true, so fail loudly if no UID line was found at all.
    expect(uid, `no UID line in body for host=${host}`).toBeTruthy();
    return uid!;
  }

  const ORIGINAL_PUBLIC_URL = process.env.PUBLIC_URL;
  afterEach(() => {
    if (ORIGINAL_PUBLIC_URL === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = ORIGINAL_PUBLIC_URL;
  });

  it("identical UID across two hostnames when PUBLIC_URL is unset", async () => {
    delete process.env.PUBLIC_URL;
    armOneEvent();
    const viaDefault = await uidVia("pod.antoine.synap.live");
    const viaCustom = await uidVia("calendar.antoine.example");
    expect(viaDefault).toBe(viaCustom);
    // And it is the reserved synthetic namespace, not either request host.
    expect(viaDefault).toBe(`${ENTITY_ID}@synap.invalid`);
    expect(viaDefault).not.toContain("synap.live");
    expect(viaCustom).not.toContain("antoine.example");
  });

  it("uses PUBLIC_URL when set, still ignoring the request host", async () => {
    process.env.PUBLIC_URL = "https://pod.antoine.synap.live/";
    armOneEvent();
    const viaCustom = await uidVia("calendar.antoine.example");
    expect(viaCustom).toBe(`${ENTITY_ID}@pod.antoine.synap.live`);
    expect(await uidVia("pod.antoine.synap.live")).toBe(viaCustom);
  });

  it("SEQUENCE reaches the real response body too", async () => {
    delete process.env.PUBLIC_URL;
    armOneEvent();
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    const body = await res.text();
    expect(body).toMatch(/^SEQUENCE:\d+\r?$/m);
    expect(Number(/^SEQUENCE:(\d+)\r?$/m.exec(body)![1])).toBeGreaterThan(0);
  });
});

/**
 * Conditional GET — the whole payoff of computing an ETag at all.
 *
 * `calendar_feed` exists to be polled every 5-15 minutes per client; without
 * a 304 path the ETag was decorative and every poll re-downloaded the full
 * body forever.
 */
describe("GET /calendar/feed/:token.ics — conditional GET (If-None-Match)", () => {
  function armFeed() {
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
  }

  async function firstEtag(): Promise<string> {
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(res.status).toBe(200);
    return res.headers.get("etag")!;
  }

  it("a first GET returns 200 with a body and an ETag", async () => {
    armFeed();
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it("a second GET with the matching ETag returns 304 with no body", async () => {
    armFeed();
    const etag = await firstEtag();
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    // A 304 MUST still carry ETag + Cache-Control.
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
  });

  it("a GET with a non-matching ETag returns 200", async () => {
    armFeed();
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { "If-None-Match": '"deadbeef-0"' },
    });
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it("accepts a comma-separated If-None-Match list", async () => {
    armFeed();
    const etag = await firstEtag();
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { "If-None-Match": `"bogus-0", ${etag}` },
    });
    expect(res.status).toBe(304);
  });

  it("accepts a weak-prefixed echo of our (strong) tag", async () => {
    armFeed();
    const etag = await firstEtag();
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { "If-None-Match": `W/${etag}` },
    });
    expect(res.status).toBe(304);
  });

  it("If-None-Match: * always matches", async () => {
    armFeed();
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { "If-None-Match": "*" },
    });
    expect(res.status).toBe(304);
  });

  it("lastAccessedAt is still written on a 304 (a conditional GET is still a poll)", async () => {
    armFeed();
    const etag = await firstEtag();
    updateWhereMock.mockClear();
    const app = buildApp();
    const res = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(updateWhereMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * THE THING THE DAY-BUCKET WAS FOR — proves the staleness bound, not just the
 * 304 mechanics above.
 *
 * The feed body depends on `now` (the -30d/+365d rolling window), so an entity
 * can enter/leave the rendered feed with ZERO `updatedAt` change. Without a
 * clock component in the tag, this whole suite passes even if the day bucket
 * is deleted from `computeFeedEtag` — asserted below by mutation.
 *
 * Fixed clock via `vi.setSystemTime`, because the handler computes `now`
 * internally (`new Date()`) — there is no injection seam, so moving the clock
 * is the only way to cross a day boundary deterministically.
 */
describe("GET /calendar/feed/:token.ics — ETag reflects the calendar day", () => {
  // Fixed data, never touched between calls: the whole point is that NOTHING
  // about the row or the entity changes — only the clock moves.
  const DAY1 = new Date("2026-08-01T10:00:00.000Z");
  const SAME_DAY_LATER = new Date("2026-08-01T15:00:00.000Z");
  const DAY2 = new Date("2026-08-02T10:00:00.000Z");
  const FIXED_UPDATED_AT = new Date("2026-07-20T00:00:00.000Z");

  function armFixedFeed() {
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
          properties: { dueDate: "2026-08-05" }, // within window on both DAY1 and DAY2
          type: "task",
          profileSlug: "task",
          updatedAt: FIXED_UPDATED_AT,
        },
      ])
    );
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("changes across a day boundary with zero writes, and a stale tag no longer 304s", async () => {
    armFixedFeed();
    const app = buildApp();

    vi.useFakeTimers();
    vi.setSystemTime(DAY1);
    const resDay1 = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(resDay1.status).toBe(200);
    const etagDay1 = resDay1.headers.get("etag")!;
    expect(etagDay1).toBeTruthy();

    vi.setSystemTime(DAY2);
    const resDay2 = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    expect(resDay2.status).toBe(200);
    const etagDay2 = resDay2.headers.get("etag")!;

    // The staleness bound: no write happened, but the calendar day did, so
    // the tag MUST differ.
    expect(etagDay1).not.toBe(etagDay2);

    // The user-facing consequence: a client that cached DAY1's tag must be
    // served a fresh body on DAY2, never a 304 — that is what stops a
    // subscribed calendar freezing while entities age out of the window.
    const staleCheck = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { "If-None-Match": etagDay1 },
    });
    expect(staleCheck.status).toBe(200);
  });

  it("stays stable within the same day with no writes, and still 304s", async () => {
    armFixedFeed();
    const app = buildApp();

    vi.useFakeTimers();
    vi.setSystemTime(DAY1);
    const first = await app.request(`/calendar/feed/${TOKEN_A}.ics`);
    const etag = first.headers.get("etag")!;

    // Same calendar day, hours later, still no write.
    vi.setSystemTime(SAME_DAY_LATER);
    const second = await app.request(`/calendar/feed/${TOKEN_A}.ics`, {
      headers: { "If-None-Match": etag },
    });
    // Without this, a suite could pass with a tag that changes on EVERY
    // request — which would silently restore the bandwidth bug this feature
    // exists to fix.
    expect(second.status).toBe(304);
  });
});
