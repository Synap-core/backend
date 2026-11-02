/**
 * A tRPC server fault never carries its raw message out of a production pod
 * (audit 2026-10-28 F2).
 *
 * The defect: tRPC 11 hands a resolver throw to `errorCatchingMiddleware` as a
 * RESOLVED `{ ok: false }` result, so the production mask in that middleware's
 * `catch` never ran, and the errorFormatter returned `shape.message` as is. A
 * driver error ("duplicate key value violates unique constraint …") reached
 * the client verbatim on `/trpc/*` and `/api/hub/trpc/*`, which the Hono
 * egress door deliberately skips.
 *
 * Driven end to end through the REAL `t` (its errorFormatter is the thing
 * under test) and the REAL `errorCatchingMiddleware`, via the fetch adapter:
 * `getErrorShape` runs only on the HTTP response path (see
 * `setup-required-trpc.test.ts`). The body is deserialized with superjson, as
 * the browser client does.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import superjson, { type SuperJSONResult } from "superjson";
import { NotFoundError } from "@synap-core/core";

const logged = vi.hoisted(() => ({
  errors: [] as Array<{ obj: Record<string, unknown>; msg: string }>,
  rows: [] as Array<Record<string, unknown>>,
}));

// The fault row (`server_faults`), stubbed at the database boundary. The rest
// of the module stays real: `errorCatchingMiddleware` maps its typed errors.
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  insertServerFault: async (_db: unknown, row: Record<string, unknown>) => {
    logged.rows.push(row);
  },
  deleteExpiredServerFaults: async () => 0,
}));

vi.mock("@synap-core/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap-core/core")>();
  return {
    ...actual,
    createLogger: () => {
      const log = {
        error: (obj: Record<string, unknown>, msg: string) => {
          logged.errors.push({ obj, msg });
        },
        fatal: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
        child: () => log,
      };
      return log;
    },
  };
});

const { t } = await import("../init-trpc.js");
const { errorCatchingMiddleware } = await import("../trpc.js");
const { SERVER_FAULT_MESSAGE } = await import("../middleware/error-egress.js");
type Context = import("../context.js").Context;

const DRIVER_MESSAGE =
  'duplicate key value violates unique constraint "users_email_key"';

const testRouter = t.router({
  driverError: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new Error(DRIVER_MESSAGE);
  }),
  internalTrpcError: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "provider fetch failed: https://api.example/v1?key=sk-secret",
    });
  }),
  notFound: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new NotFoundError("Workspace", "ws-x");
  }),
});

interface TrpcErrorShape {
  message: string;
  data: {
    code: string;
    errorId?: string;
    stack?: string;
    [k: string]: unknown;
  };
}

async function call(
  path: string
): Promise<{ status: number; error: TrpcErrorShape; raw: string }> {
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
  const raw = await res.text();
  const body = JSON.parse(raw) as { error: SuperJSONResult };
  return {
    status: res.status,
    error: superjson.deserialize<TrpcErrorShape>(body.error),
    raw,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  logged.errors.length = 0;
  logged.rows.length = 0;
});

describe("tRPC server faults in production", () => {
  it("a driver error is a constant message plus an errorId the log also carries", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { status, error, raw } = await call("driverError");

    expect(status).toBe(500);
    expect(error.data.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).toBe(SERVER_FAULT_MESSAGE);
    expect(raw).not.toContain("users_email_key");
    expect(error.data.stack).toBeUndefined();
    expect(raw).not.toContain("trpc-internal-error-mask.test");

    expect(error.data.errorId).toMatch(/^[0-9a-f-]{36}$/);
    const entry = logged.errors.find(
      (e) => e.obj.errorId === error.data.errorId
    );
    expect(entry).toBeDefined();
    expect(String((entry!.obj.err as Error).message)).toBe(DRIVER_MESSAGE);
    expect((entry!.obj.fault as { message: string }).message).toBe(
      DRIVER_MESSAGE
    );
  });

  it("stores the original cause under the client's errorId and links to it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { error, raw } = await call("driverError");
    await new Promise((r) => setTimeout(r, 0));

    expect(logged.rows).toHaveLength(1);
    expect(logged.rows[0]).toMatchObject({
      errorId: error.data.errorId,
      door: "trpc",
      path: "driverError",
      status: 500,
      errorName: "Error",
      message: DRIVER_MESSAGE,
    });
    expect(String(error.data.causeUrl)).toMatch(
      new RegExp(`/errors/${error.data.errorId}$`)
    );
    expect(raw).not.toContain(DRIVER_MESSAGE);
  });

  it("an INTERNAL TRPCError thrown with its own message is masked too", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { status, error, raw } = await call("internalTrpcError");

    expect(status).toBe(500);
    expect(error.message).toBe(SERVER_FAULT_MESSAGE);
    expect(raw).not.toContain("sk-secret");
    // The stored cause keeps the message, with the credential cut.
    await new Promise((r) => setTimeout(r, 0));
    expect(String(logged.rows[0]?.message)).toBe(
      "provider fetch failed: https://api.example/v1?key=[redacted]"
    );
  });

  it("a typed 4xx keeps its message (only server faults are masked)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { status, error } = await call("notFound");

    expect(status).toBe(404);
    expect(error.message).not.toBe(SERVER_FAULT_MESSAGE);
    expect(error.message).toContain("ws-x");
    expect(error.data.errorId).toBeUndefined();
  });

  it("outside production the debugging message stays", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { error } = await call("driverError");

    expect(error.message).toBe(DRIVER_MESSAGE);
  });
});
