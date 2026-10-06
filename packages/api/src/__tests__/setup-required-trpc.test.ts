/**
 * The tRPC door must carry the SAME "setup required" payload the Hub REST
 * `POST /capabilities/apply` door does (400/412 + body, see
 * `routers/hub-protocol/rest/capabilities.ts`).
 *
 * The defect this pins: `SetupRequiredError` carries NO `.code`, so it fell
 * through `errorCatchingMiddleware`'s unknown branch → `INTERNAL_SERVER_ERROR`,
 * and the browser's `error.data.failureClass` read was permanently absent — a
 * capability install that needed a human presented as an opaque 500.
 *
 * This is a SEAM test, driven end-to-end through the REAL `t` (whose
 * errorFormatter is the thing under test) and the REAL
 * `errorCatchingMiddleware`, via the fetch adapter — nothing hand-built in
 * between. (A direct `createCallerFactory` caller would NOT exercise the
 * errorFormatter: in tRPC 11.17 `getErrorShape` is only reached on the HTTP
 * response path — verified in `@trpc/server/dist/resolveResponse-*.mjs`.) No
 * db, no PG: every procedure throws before touching a store.
 *
 * The response body is deserialized with the same superjson transformer the
 * browser client uses, so these assertions are on the exact client-visible
 * shape.
 *
 * NEGATIVE CONTROLS (both confirmed by mutating, grepping the mutated line to
 * prove the mutation landed, running, then restoring):
 *   - Removing the `...setupRequired` spread from `init-trpc.ts`'s
 *     errorFormatter turns the `failureClass` / `missingFields` / `connection`
 *     assertions red (they read `undefined`) while the code/status assertions
 *     stay green — the payload forwarding is load-bearing.
 *   - Disabling the `!result.ok && isSetupRequiredLike(result.error.cause)`
 *     branch in `errorCatchingMiddleware` turns the code/status assertions red
 *     (`INTERNAL_SERVER_ERROR` instead of `BAD_REQUEST`/`PRECONDITION_FAILED`) —
 *     the code mapping is load-bearing.
 */
import { describe, it, expect } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson, { type SuperJSONResult } from "superjson";
import { t } from "../init-trpc.js";
import { errorCatchingMiddleware } from "../trpc.js";
import { SetupRequiredError } from "../services/proposals/setup-required-error.js";
import type { Context } from "../context.js";
import { NotFoundError } from "@synap-core/core";
import { WorkspaceIdentityConflictError } from "@synap/database";

const testRouter = t.router({
  missingField: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new SetupRequiredError({
      failureClass: "missing_field",
      missingFields: ["calendarId", "apiKey"],
      labels: ["Calendar ID", "API key"],
    });
  }),
  noConnection: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new SetupRequiredError({
      failureClass: "no_connection",
      connection: { provider: "google", state: "missing" },
    });
  }),
  /** A typed domain refusal (0308) — must keep its 409 and its reasonCode. */
  identityConflict: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new WorkspaceIdentityConflictError("name", "Content OS", "ws-1");
  }),
  /** Any SynapError keeps its status (was an opaque 500 — probed 2026-10-06). */
  notFound: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new NotFoundError("Workspace", "ws-x");
  }),
  /** An honest unknown — MUST stay an opaque 500 (the unchanged contract). */
  boom: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new Error("kaboom");
  }),
});

interface TrpcErrorShape {
  message: string;
  data: { code: string; failureClass?: string; [k: string]: unknown };
}

async function call(
  path: string
): Promise<{ status: number; error: TrpcErrorShape }> {
  const req = new Request(`http://localhost/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(superjson.serialize({})),
  });
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req,
    router: testRouter,
    createContext: () => ({}) as Context,
  });
  // tRPC superjson-transforms the error VALUE into `{ error: { json, meta } }`.
  // Deserialize exactly as the browser client's transformer does.
  const raw = (await res.json()) as { error: SuperJSONResult };
  const error = superjson.deserialize<TrpcErrorShape>(raw.error);
  return { status: res.status, error };
}

describe("tRPC door — setup-required payload survives the hop", () => {
  it("missing_field → BAD_REQUEST/400 carrying failureClass + missingFields", async () => {
    const { status, error } = await call("missingField");

    // The code mapping is the shared `CLASS_TRPC_CODE` derivation — the SAME
    // code the Hub REST door returns for a missing_field.
    expect(error.data.code).toBe("BAD_REQUEST");
    expect(status).toBe(400);

    // The payload the REST door also returns — this is what was dropped.
    expect(error.data.failureClass).toBe("missing_field");
    expect(error.data.missingFields).toEqual(["calendarId", "apiKey"]);
    // The value-free sentence rides as the message (labels, never values).
    expect(error.message).toBe("Needs setup: Calendar ID, API key.");
  });

  it("no_connection → PRECONDITION_FAILED/412 carrying connection", async () => {
    const { status, error } = await call("noConnection");

    expect(error.data.code).toBe("PRECONDITION_FAILED");
    expect(status).toBe(412);

    expect(error.data.failureClass).toBe("no_connection");
    expect(error.data.connection).toEqual({
      provider: "google",
      state: "missing",
    });
    // `missingFields` is present-but-empty for a pure connection failure.
    expect(error.data.missingFields).toEqual([]);
  });

  it("a typed SynapError keeps its status: identity conflict → CONFLICT/409 + reasonCode", async () => {
    const { status, error } = await call("identityConflict");
    expect(error.data.code).toBe("CONFLICT");
    expect(status).toBe(409);
    expect(error.data.reasonCode).toBe("WORKSPACE_IDENTITY_CONFLICT");
    expect(error.message).toContain('"Content OS" already exists');
  });

  it("…and any other SynapError too (NotFoundError → NOT_FOUND/404)", async () => {
    const { status, error } = await call("notFound");
    expect(error.data.code).toBe("NOT_FOUND");
    expect(status).toBe(404);
  });

  it("an unclassified error stays an opaque INTERNAL_SERVER_ERROR", async () => {
    // The guard must not have widened: only `isSetupRequiredLike` payloads are
    // forwarded, and a bare Error keeps the debugging message + 500.
    const { status, error } = await call("boom");

    expect(error.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(status).toBe(500);
    expect(error.data.failureClass).toBeUndefined();
    expect(error.data.missingFields).toBeUndefined();
    expect(error.message).toBe("kaboom");
  });
});
