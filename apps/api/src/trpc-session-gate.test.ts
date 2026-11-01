/**
 * The main `/trpc` session gate (W0).
 *
 * tRPC 11 batches by default (`allowBatching ?? true`) and splits a batch path
 * on "," (`@trpc/server` resolveResponse, `jsonContentTypeHandler.parse`). The
 * gate used to skip the session check when the RAW path merely contained
 * `health.` / `setup.` / an invite procedure, so
 * `/trpc/health.x,n8nActions.createEntity?batch=1` reached a session-only
 * procedure with no session.
 *
 * Driven through the REAL session middleware (`@synap/auth`) and the REAL tRPC
 * fetch adapter, with a stand-in router that has one public and one
 * session-only procedure of the same names as the real ones.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PUBLIC_TRPC_NAMESPACES,
  PUBLIC_TRPC_PROCEDURES,
  isPublicTrpcRequest,
  trpcSessionGate,
} from "./trpc-session-gate.js";
import { stripComments } from "../../../scripts/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const t = initTRPC.create();
let reachedPrivate = 0;
const router = t.router({
  health: t.router({
    alive: t.procedure.query(() => "ok"),
    ready: t.procedure.query(() => "ready"),
    metrics: t.procedure.query(() => {
      reachedPrivate++;
      return "metrics";
    }),
    readyDetails: t.procedure.query(() => {
      reachedPrivate++;
      return "details";
    }),
    migrations: t.procedure.query(() => {
      reachedPrivate++;
      return "migrations";
    }),
  }),
  setup: t.router({ status: t.procedure.query(() => "setup") }),
  workspaces: t.router({
    previewInvite: t.procedure.query(() => "preview"),
    listWorkspaces: t.procedure.query(() => {
      reachedPrivate++;
      return "private";
    }),
  }),
  n8nActions: t.router({
    createEntity: t.procedure.mutation(() => {
      reachedPrivate++;
      return "created";
    }),
  }),
});

let authMiddleware: MiddlewareHandler;

beforeAll(async () => {
  delete process.env.LOCAL_MODE;
  ({ authMiddleware } = await import("@synap/auth"));
});

function makeApp() {
  const app = new Hono();
  app.use("/trpc/*", trpcSessionGate(authMiddleware));
  app.use("/trpc/*", async (c) => {
    const res = await fetchRequestHandler({
      endpoint: "/trpc",
      req: c.req.raw,
      router,
      createContext: () => ({}),
    });
    return c.newResponse(res.body, res);
  });
  return app;
}

const BEARER = { authorization: "Bearer synap_hub_live_not_a_session" };

function post(url: string, headers: Record<string, string> = BEARER) {
  return makeApp().request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ 0: {}, 1: {} }),
  });
}

describe("main /trpc session gate — batch paths", () => {
  it("a batch that hides a session-only mutation behind health.* is 401", async () => {
    const before = reachedPrivate;
    const res = await post("/trpc/health.x,n8nActions.createEntity?batch=1");
    expect(res.status).toBe(401);
    expect(reachedPrivate).toBe(before);
  });

  it("…in either order, and behind setup.* / an invite procedure", async () => {
    const before = reachedPrivate;
    for (const url of [
      "/trpc/n8nActions.createEntity,health.alive?batch=1",
      "/trpc/setup.status,n8nActions.createEntity?batch=1",
      "/trpc/workspaces.previewInvite,n8nActions.createEntity?batch=1",
    ]) {
      expect((await post(url)).status, url).toBe(401);
    }
    expect(reachedPrivate).toBe(before);
  });

  it("the GET form of the same batch is 401", async () => {
    const before = reachedPrivate;
    const input = encodeURIComponent(JSON.stringify({ 0: {}, 1: {} }));
    const res = await makeApp().request(
      `/trpc/health.alive,workspaces.listWorkspaces?batch=1&input=${input}`,
      { headers: BEARER }
    );
    expect(res.status).toBe(401);
    expect(reachedPrivate).toBe(before);
  });

  it("a public NAME as a substring of a private path does not open it", async () => {
    expect(isPublicTrpcRequest("/trpc/xhealth.alive")).toBe(false);
    expect(isPublicTrpcRequest("/trpc/n8nActions.createEntity/health.")).toBe(
      false
    );
    expect(isPublicTrpcRequest("/trpc/workspaces.previewInviteX")).toBe(false);
  });

  it("an encoded comma never reaches the private procedure", async () => {
    const before = reachedPrivate;
    const res = await post(
      "/trpc/health.alive%2Cn8nActions.createEntity?batch=1"
    );
    expect(res.status).not.toBe(200);
    expect(reachedPrivate).toBe(before);
  });
});

describe("main /trpc session gate — the public doors still work", () => {
  it("plain /trpc/health.alive works without a session", async () => {
    const res = await makeApp().request("/trpc/health.alive");
    expect(res.status).toBe(200);
  });

  it("an all-public batch works without a session", async () => {
    const input = encodeURIComponent(JSON.stringify({ 0: {}, 1: {} }));
    const res = await makeApp().request(
      `/trpc/health.alive,setup.status?batch=1&input=${input}`
    );
    expect(res.status).toBe(200);
  });

  it("the CP's invite preview (single-path batch) works without a session", async () => {
    const input = encodeURIComponent(JSON.stringify({ 0: { json: {} } }));
    const res = await makeApp().request(
      `/trpc/workspaces.previewInvite?batch=1&input=${input}`
    );
    expect(res.status).toBe(200);
  });

  it("CONTROL — a session-only procedure alone is 401 to a Bearer key", async () => {
    expect((await post("/trpc/n8nActions.createEntity")).status).toBe(401);
  });
});

describe("main /trpc session gate — health is public only for its probes (audit F12)", () => {
  it("health.metrics, health.readyDetails and health.migrations need a session", async () => {
    const before = reachedPrivate;
    for (const p of ["metrics", "readyDetails", "migrations"]) {
      const res = await makeApp().request(`/trpc/health.${p}`, {
        headers: BEARER,
      });
      expect(res.status, p).toBe(401);
    }
    expect(reachedPrivate).toBe(before);
  });

  it("…also behind a public probe in a batch", async () => {
    const before = reachedPrivate;
    const input = encodeURIComponent(JSON.stringify({ 0: {}, 1: {} }));
    const res = await makeApp().request(
      `/trpc/health.ready,health.metrics?batch=1&input=${input}`,
      { headers: BEARER }
    );
    expect(res.status).toBe(401);
    expect(reachedPrivate).toBe(before);
  });

  it("health.ready works without a session", async () => {
    expect((await makeApp().request("/trpc/health.ready")).status).toBe(200);
  });

  it("the gate's public health names are exactly the router's publicProcedure ones", () => {
    // Derived from the real router source, so a procedure made public there
    // and not here (or the reverse) is caught.
    const healthSrc = stripComments(
      readFileSync(
        path.join(HERE, "../../../packages/api/src/routers/health.ts"),
        "utf8"
      ),
      "ts"
    ) as string;
    const declared = [...healthSrc.matchAll(/^\s{2}(\w+):\s*(\w+)\./gm)].map(
      (m) => ({ name: m[1], builder: m[2] })
    );
    expect(declared.map((d) => d.name)).toContain("metrics");
    const routerPublic = declared
      .filter((d) => d.builder === "publicProcedure")
      .map((d) => `health.${d.name}`)
      .sort();
    const gatePublic = [...PUBLIC_TRPC_PROCEDURES]
      .filter((p) => p.startsWith("health."))
      .sort();
    expect(gatePublic).toEqual(routerPublic);
    expect(PUBLIC_TRPC_NAMESPACES).not.toContain("health");
  });
});

describe("index.ts mounts the ONE gate", () => {
  const src = stripComments(
    readFileSync(path.join(HERE, "index.ts"), "utf8"),
    "ts"
  ) as string;

  it("uses trpcSessionGate(appSessionMiddleware()) on /trpc/*", () => {
    // The Kratos session gate, widened ONLY to a Synap app's device token
    // (packages/api middleware/app-session.ts, its own bearer tripwire).
    expect(src).toContain(
      'app.use("/trpc/*", trpcRefusal(trpcSessionGate(appSessionMiddleware())))'
    );
  });

  it("has no raw-path substring skip left", () => {
    expect(src).not.toMatch(/path\.includes\(\s*["'](health|setup)\./);
    expect(src).not.toMatch(
      /includes\(\s*["']workspaces\.(previewInvite|acceptInviteViaCp)/
    );
  });
});
