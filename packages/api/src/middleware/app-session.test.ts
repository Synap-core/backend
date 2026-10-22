/**
 * TRIPWIRE `app-session-bearer` — the app API's session gate turns exactly ONE
 * kind of bearer into a person: a Synap app's device token.
 *
 * WHY: `/trpc` runs a request as the PERSON with no governance in between
 * (writes auto-apply, approvals are theirs). A gate that resolved any other
 * bearer — a PAT, an agent or machine key, an app's person token — into that
 * context would hand an agent the human path. Keys keep their own doors.
 *
 * HOW: the REAL middleware, a stand-in for the Kratos half (records that it
 * was reached, answers 401 like a request with no session), and the one
 * lookup mocked so a test can see whether it was asked. The set of key
 * grammars is DERIVED from the schema (`KEY_PREFIXES`), so a new key prefix
 * joins this test by existing.
 *
 * The real lookup on a real database is driven end to end in
 * `services/person-device-token.pglite.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";

const h = vi.hoisted(() => ({
  resolved: [] as string[],
  fail: false,
}));

vi.mock("@synap/database", () => ({ db: { sentinel: "pod-db" } }));
vi.mock("@synap/database/person-devices", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@synap/database/person-devices")>();
  return {
    ...actual,
    resolvePersonDeviceSession: async (_db: unknown, raw: string) => {
      h.resolved.push(raw);
      if (h.fail) throw new Error("db down");
      if (raw !== GOOD) return null;
      return {
        identity: { id: "person-1", traits: { email: "p@x", name: "P" } },
        active: true,
        device: { id: "device-1", clientId: "synap-desktop" },
      };
    },
  };
});

import { KEY_PREFIXES } from "@synap/database/schema";
import { PERSON_DEVICE_TOKEN_PREFIX } from "@synap/database/person-devices";
import { appSessionMiddleware, bearerCredential } from "./app-session.js";
import { assertFreshAuthentication } from "../utils/device-session.js";

const GOOD = `${PERSON_DEVICE_TOKEN_PREFIX}${"g".repeat(43)}`;

let kratosReached = 0;
const kratosStandIn: MiddlewareHandler = async (c) => {
  kratosReached++;
  return c.json({ error: "Invalid session", by: "kratos" }, 401);
};

function makeApp() {
  const app = new Hono();
  app.use("/trpc/*", appSessionMiddleware(kratosStandIn));
  app.get("/trpc/me", (c) =>
    c.json({
      userId: c.get("userId" as never),
      device: (c.get("session" as never) as { device?: unknown })?.device,
    })
  );
  return app;
}

const get = (authorization?: string, cookie?: string) =>
  makeApp().request("/trpc/me", {
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });

beforeEach(() => {
  h.resolved = [];
  h.fail = false;
  kratosReached = 0;
});

describe("app-session-bearer — only a device token becomes a person", () => {
  const keyPrefixes = Object.values(KEY_PREFIXES) as string[];

  it("non-vacuity: the derived key grammars are there", () => {
    expect(keyPrefixes.length).toBeGreaterThanOrEqual(3);
    expect(keyPrefixes).toContain("synap_user_");
  });

  it.each(keyPrefixes)(
    "a %s… key as a bearer is ignored: the Kratos half judges, no lookup",
    async (prefix) => {
      const res = await get(`Bearer ${prefix}${"k".repeat(40)}`);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { by?: string }).by).toBe("kratos");
      expect(kratosReached).toBe(1);
      expect(h.resolved).toEqual([]);
    }
  );

  it.each([
    ["a Kratos session token sent as a bearer", "Bearer ory_st_abcdef"],
    ["a bare prefix", `Bearer ${PERSON_DEVICE_TOKEN_PREFIX}`],
    ["another scheme", `Basic ${GOOD}`],
    ["no scheme", GOOD],
  ])("%s is ignored", async (_why, header) => {
    const res = await get(header);
    expect(res.status).toBe(401);
    expect(kratosReached).toBe(1);
    expect(h.resolved).toEqual([]);
  });

  it("CONTROL — a live device token is the person, with its device", async () => {
    const res = await get(`bearer ${GOOD}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "person-1",
      device: { id: "device-1", clientId: "synap-desktop" },
    });
    expect(kratosReached).toBe(0);
    expect(h.resolved).toEqual([GOOD]);
  });

  it("a dead device token is 401 invalid_token — never a fall-through to a cookie", async () => {
    const res = await get(
      `Bearer ${PERSON_DEVICE_TOKEN_PREFIX}${"d".repeat(43)}`,
      "ory_kratos_session=someone-elses"
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    expect(kratosReached).toBe(0);
  });

  it("a failed lookup is 503 — never 'signed out'", async () => {
    h.fail = true;
    const res = await get(`Bearer ${GOOD}`);
    expect(res.status).toBe(503);
    expect(kratosReached).toBe(0);
  });

  it("no bearer: the Kratos half judges, unchanged", async () => {
    await get(undefined, "ory_kratos_session=abc");
    expect(kratosReached).toBe(1);
    expect(h.resolved).toEqual([]);
  });
});

describe("a Kratos session sent as a token carries its clock into the request scope", () => {
  // The Kratos half resolved an X-Session-Token whose last sign-in is `at`.
  const tokenApp = (at: Date, kind = "kratos_token") => {
    const app = new Hono();
    const kratos: MiddlewareHandler = async (c, next) => {
      c.set(
        "session" as never,
        {
          id: "kratos-session-1",
          identity: { id: "person-1", traits: { email: "p@x" } },
          authenticated_at: at.toISOString(),
        } as never
      );
      c.set("sessionKind" as never, kind as never);
      return next();
    };
    app.use("/trpc/*", appSessionMiddleware(kratos));
    // A service deep in a request, with no ctx: only the scope can tell.
    app.get("/trpc/write", (c) => {
      try {
        assertFreshAuthentication();
        return c.json({ ok: true });
      } catch (e) {
        return c.json({ refused: (e as { code?: string }).code }, 403);
      }
    });
    return app;
  };
  const MIN = 60_000;

  it("signed in 6 minutes ago: a credential write deep in a service is refused", async () => {
    const res = await tokenApp(new Date(Date.now() - 6 * MIN)).request(
      "/trpc/write"
    );
    expect(res.status).toBe(403);
  });

  it("CONTROL — signed in a minute ago: it passes", async () => {
    const res = await tokenApp(new Date(Date.now() - MIN)).request(
      "/trpc/write"
    );
    expect(res.status).toBe(200);
  });

  it("CONTROL — a browser cookie session (unmarked) is not asked, however old", async () => {
    const res = await tokenApp(new Date(Date.now() - 600 * MIN), "").request(
      "/trpc/write"
    );
    expect(res.status).toBe(200);
  });
});

describe("bearerCredential", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["  BEARER   abc  ", "abc"],
    ["Bearer a b", null],
    ["Bearer", null],
    ["Basic abc", null],
    [undefined, null],
  ])("%s → %s", (header, expected) => {
    expect(bearerCredential(header)).toBe(expected);
  });
});
