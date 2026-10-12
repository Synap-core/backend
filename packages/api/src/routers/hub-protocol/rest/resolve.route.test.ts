/**
 * `GET /resolve/:id` — a FAILED lookup is not an EMPTY one.
 *
 * The route used to `catch` a resolver failure and answer the 200
 * `{ type: "unknown" }` that means "nothing you can see has this id", so a
 * broken probe rendered as a calm "Nothing to open." in the CLI and the app.
 * Drives the REAL route + the real `browserRouteFor` projection; only the
 * prober and the acting-context resolution are stubbed.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "4d3e8f37-d33b-4ec6-8146-a071ab37136a";

// A plain switchable stub, not a `vi.fn`: under this package's vitest
// (4.0.17) a hoisted `vi.fn` whose implementation rejects fails the test even
// when the rejection is awaited and caught — observed, not explained.
const probe = vi.hoisted(() => ({
  impl: (async () => null) as (...args: unknown[]) => Promise<unknown>,
}));

vi.mock(
  "../../../services/diagnose/resolve-object-kind.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../services/diagnose/resolve-object-kind.js")
    >()),
    resolveObjectKind: (...args: unknown[]) => probe.impl(...args),
  })
);

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    resolveActingContext: vi.fn(async () => ({
      ok: true,
      workspaceId: null,
      userId: "user-1",
    })),
  };
});

const { registerResolveRoutes, RESOLVE_FAILED_CODE } =
  await import("./resolve.js");

function app() {
  const a = new OpenAPIHono();
  a.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    await next();
  });
  registerResolveRoutes(a as never);
  return a;
}

function setResolved(value: unknown) {
  probe.impl = async () => value;
}

async function get(id = ID) {
  const res = await app().request(`/resolve/${id}`);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("GET /resolve/:id", () => {
  beforeEach(() => {
    probe.impl = async () => null;
  });

  it("a FAILED probe is a 500 with a typed error, never a 200 `unknown`", async () => {
    probe.impl = async () => {
      throw new Error("connection terminated");
    };
    const { status, body } = await get();
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: RESOLVE_FAILED_CODE, id: ID });
    expect(typeof body.error).toBe("string");
    expect(body.type).toBeUndefined();
  });

  it("not-found stays the 200 `unknown` answer", async () => {
    setResolved(null);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual({
      type: "unknown",
      id: ID,
      displayName: null,
      workspaceId: null,
      openable: false,
    });
  });

  it("a skill resolves to the routable `skill` label (the create_skill link)", async () => {
    setResolved({
      kind: "capability",
      subKind: "skill",
      id: ID,
      displayName: "summarize",
      workspaceId: null,
    });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ type: "skill", id: ID, openable: true });
  });

  it.each(["playbook", "automation", "project", "channel"] as const)(
    "a %s resolves to its own routable label",
    async (kind) => {
      setResolved({ kind, id: ID, displayName: "x" });
      const { status, body } = await get();
      expect(status).toBe(200);
      expect(body).toMatchObject({ type: kind, id: ID, openable: true });
    }
  );

  it("a kind with no browser door is reported, not linked", async () => {
    setResolved({ kind: "external_send", id: ID });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ type: "external_send", openable: false });
  });
});
