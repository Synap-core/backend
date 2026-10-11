/**
 * A stale status move must reach a tRPC client as DATA: `CONFLICT` with
 * `data.reasonCode = "LIFECYCLE_STALE"` and the status the thing is in now
 * (`data.currentStatus`), so the one frontend mover (`useMoveStatus`) says
 * "Moved meanwhile to X" without parsing the message.
 *
 * Seam test through the REAL `t` (its errorFormatter) and the REAL
 * `errorCatchingMiddleware`, via the fetch adapter, deserialized with
 * superjson like the browser client (same harness as
 * `setup-required-trpc.test.ts`).
 *
 * NEGATIVE CONTROL: removing `...lifecycleStale` from the errorFormatter turns
 * the reasonCode/currentStatus assertions red while the code stays CONFLICT.
 */
import { describe, it, expect } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson, { type SuperJSONResult } from "superjson";
import { t } from "../init-trpc.js";
import { errorCatchingMiddleware } from "../trpc.js";
import { lifecycleConflictError } from "../services/lifecycle/conflict.js";
import type { Context } from "../context.js";

const testRouter = t.router({
  stale: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw lifecycleConflictError("lead", "qualified");
  }),
  staleFromNone: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw lifecycleConflictError(null, "lead");
  }),
});

async function call(path: string) {
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
  const raw = (await res.json()) as { error: SuperJSONResult };
  return {
    status: res.status,
    error: superjson.deserialize<{
      message: string;
      data: Record<string, unknown>;
    }>(raw.error),
  };
}

describe("tRPC door — a stale status move carries the current status", () => {
  it("CONFLICT/409 with reasonCode + expected + current", async () => {
    const { status, error } = await call("stale");
    expect(status).toBe(409);
    expect(error.data.code).toBe("CONFLICT");
    expect(error.data.reasonCode).toBe("LIFECYCLE_STALE");
    expect(error.data.expectedStatus).toBe("lead");
    expect(error.data.currentStatus).toBe("qualified");
  });

  it("an expected 'none' arrives as null, never the word", async () => {
    const { error } = await call("staleFromNone");
    expect(error.data.expectedStatus).toBeNull();
    expect(error.data.currentStatus).toBe("lead");
  });
});
