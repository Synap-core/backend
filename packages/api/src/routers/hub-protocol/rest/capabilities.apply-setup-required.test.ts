/**
 * `POST /capabilities/apply` — a SETUP-REQUIRED failure is not a 500.
 *
 * `SetupRequiredError` carries no `.code`, so the route's catch used to fall
 * through to `httpStatusForTrpcError`, which speaks only tRPC codes and answers
 * 500 — an opaque internal error for what is really "a human must supply a param
 * or connect an account". This drives the REAL route with a mocked applier that
 * throws the real `SetupRequiredError` and asserts the structured body arrives
 * with the mapped status (400 / 412), plus that a genuinely unknown error still
 * answers 500. Modelled on `catch-status-mapping.test.ts` (same-dir harness).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SetupRequiredError } from "../../../services/proposals/setup-required-error.js";

const USER = "0aaaaaaa-0000-4000-8000-000000000001";

const applyCapability = vi.fn();
vi.mock(
  "../../../services/capabilities/create-from-definition.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../services/capabilities/create-from-definition.js")
      >();
    return {
      ...actual,
      createCapabilityFromDefinition: (...a: unknown[]) => applyCapability(...a),
    };
  }
);

// Keep the route's deps off the DB / real identity resolution: the acting
// context is "whatever the middleware set", and the caller ctx is a stub.
vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./_shared.js")>();
  return {
    ...actual,
    resolveActingContext: async () => ({
      ok: true,
      userId: USER,
      workspaceId: null,
      role: "owner",
    }),
  };
});
vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    createHubProtocolCallerContext: async () => ({ userId: USER }),
  };
});

const { registerCapabilitiesRoutes } = await import("./capabilities.js");

function makeApp() {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("userId" as never, USER as never);
    c.set("scopes" as never, ["hub-protocol.write"] as never);
    await next();
  });
  registerCapabilitiesRoutes(app as never);
  return app;
}

const applyReq = (body: Record<string, unknown>) =>
  makeApp().request("/capabilities/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      definition: { key: "demo", name: "Demo" },
      ...body,
    }),
  });

describe("POST /capabilities/apply — setup-required failures", () => {
  beforeEach(() => {
    applyCapability.mockReset();
  });

  it("a missing_field SetupRequiredError answers 400 with the structured body", async () => {
    applyCapability.mockImplementation(async () => {
      throw new SetupRequiredError({
        failureClass: "missing_field",
        missingFields: ["apiKey"],
      });
    });
    const res = await applyReq({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.failureClass).toBe("missing_field");
    expect(body.missingFields).toEqual(["apiKey"]);
    expect(body.message).toBeTruthy();
  });

  it("a no_connection SetupRequiredError answers 412 with the connection facts", async () => {
    applyCapability.mockImplementation(async () => {
      throw new SetupRequiredError({
        failureClass: "no_connection",
        connection: { provider: "google", state: "expired" },
      });
    });
    const res = await applyReq({});
    expect(res.status).toBe(412);
    const body = await res.json();
    expect(body.failureClass).toBe("no_connection");
    expect(body.connection).toEqual({ provider: "google", state: "expired" });
    expect(body.message).toContain("google");
  });

  it("a genuinely unknown error still answers 500", async () => {
    applyCapability.mockImplementation(async () => {
      throw new Error("db down");
    });
    const res = await applyReq({});
    expect(res.status).toBe(500);
  });
});
