/**
 * A refused tRPC input must reach the client as FIELD ERRORS:
 * `BAD_REQUEST` with `data.fieldErrors = { "<dotted path>": [messages] }`
 * and a readable `message`, never zod's JSON dump of the issue array — so a
 * form puts each message under its field without parsing anything.
 *
 * Seam test through the REAL `t` (its errorFormatter) and the REAL
 * `errorCatchingMiddleware`, via the fetch adapter, deserialized with
 * superjson like the browser client (same harness as
 * `lifecycle-conflict-trpc.test.ts`).
 *
 * NEGATIVE CONTROL: removing `...fieldErrors` from the errorFormatter turns the
 * fieldErrors assertions red; restoring `message: shape.message` turns the
 * readable-message assertion red.
 */
import { describe, it, expect } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import superjson, { type SuperJSONResult } from "superjson";
import { z } from "zod";
import { t } from "../init-trpc.js";
import { errorCatchingMiddleware } from "../trpc.js";
import type { Context } from "../context.js";

const Input = z.object({
  title: z.string().min(1),
  email: z.string().email(),
  items: z.array(z.object({ n: z.number() })),
});

const testRouter = t.router({
  create: t.procedure
    .use(errorCatchingMiddleware)
    .input(Input)
    .mutation(() => ({ ok: true })),
  // A ZodError behind an INTERNAL error is the server's own parse failing:
  // its paths are not the caller's fields.
  internalParse: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    Input.parse({});
    return { ok: true };
  }),
  // A door that wrote its own message keeps it, and still names the fields.
  ownMessage: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    const parsed = Input.safeParse({ title: "", email: "a@b.co", items: [] });
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That definition is not valid.",
      cause: parsed.error,
    });
  }),
  plainBadRequest: t.procedure.use(errorCatchingMiddleware).mutation(() => {
    throw new TRPCError({ code: "BAD_REQUEST", message: "No." });
  }),
});

async function call(path: string, input: unknown = {}) {
  const req = new Request(`http://localhost/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(superjson.serialize(input)),
  });
  const res = await fetchRequestHandler({
    endpoint: "/trpc",
    req,
    router: testRouter,
    createContext: () => ({}) as Context,
  });
  const text = await res.text();
  const raw = JSON.parse(text) as { error: SuperJSONResult };
  return {
    status: res.status,
    text,
    error: superjson.deserialize<{
      message: string;
      data: Record<string, unknown>;
    }>(raw.error),
  };
}

describe("tRPC door — a refused input names its fields", () => {
  it("BAD_REQUEST/400 with fieldErrors keyed by dotted path", async () => {
    const { status, error } = await call("create", {
      title: "",
      email: "not-an-email-SECRET",
      items: [{ n: 1 }, { n: "two" }],
    });
    expect(status).toBe(400);
    expect(error.data.code).toBe("BAD_REQUEST");
    const fieldErrors = error.data.fieldErrors as Record<string, string[]>;
    expect(Object.keys(fieldErrors).sort()).toEqual([
      "email",
      "items.1.n",
      "title",
    ]);
    for (const messages of Object.values(fieldErrors)) {
      expect(messages.length).toBeGreaterThan(0);
      for (const m of messages) expect(typeof m).toBe("string");
    }
  });

  it("the message is one readable sentence, not the issue array", async () => {
    const { error } = await call("create", {
      title: "",
      email: "a@b.co",
      items: [],
    });
    expect(error.message.trim().startsWith("[")).toBe(false);
    expect(error.message).toMatch(/^title: /);
  });

  it("never echoes the value the caller sent", async () => {
    const { text } = await call("create", {
      title: "ok",
      email: "not-an-email-SECRET",
      items: [],
    });
    expect(text).not.toContain("SECRET");
  });

  it("a door's own message is kept, with the fields beside it", async () => {
    const { status, error } = await call("ownMessage");
    expect(status).toBe(400);
    expect(error.message).toBe("That definition is not valid.");
    expect(Object.keys(error.data.fieldErrors as object)).toEqual(["title"]);
  });

  it("no fieldErrors on a server-side parse failure (INTERNAL)", async () => {
    const { status, error } = await call("internalParse");
    expect(status).toBe(500);
    expect(error.data.fieldErrors).toBeUndefined();
  });

  it("no fieldErrors on a BAD_REQUEST that is not a validation", async () => {
    const { error } = await call("plainBadRequest");
    expect(error.message).toBe("No.");
    expect(error.data.fieldErrors).toBeUndefined();
  });
});
