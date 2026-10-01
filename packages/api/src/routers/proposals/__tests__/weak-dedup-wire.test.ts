/**
 * The HTTP error formatter is the seam clients actually read.
 * A direct createCaller does not run errorFormatter (tRPC 11 only shapes
 * errors on the fetch adapter). This file drives the real `t` formatter.
 *
 * Not covered: a live proposals.approve call whose entities.create hits the
 * weak gate. The executor test asserts that cause is rethrown; this file
 * asserts the formatter projects it. The two are not joined by one HTTP call.
 */
import { describe, it, expect } from "vitest";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson, { type SuperJSONResult } from "superjson";
import { TRPCError } from "@trpc/server";
import { buildWeakDedupCause } from "@synap/database";
import { t } from "../../../init-trpc.js";
import { assertReviewedRevision } from "../../../utils/reviewed-revision.js";
import {
  readWeakDedupWire,
  weakDedupFailureFields,
} from "../../../utils/weak-dedup-wire.js";
import type { Context } from "../../../context.js";

const CANDIDATE = "22222222-2222-4222-8222-222222222222";

const cause = buildWeakDedupCause([
  { id: CANDIDATE, title: "Ada", type: "note" },
]);

const testRouter = t.router({
  weak: t.procedure.mutation(() => {
    throw new TRPCError({
      code: "CONFLICT",
      message: "An entity named Ada already exists.",
      cause,
    });
  }),
  weakWithExtra: t.procedure.mutation(() => {
    throw new TRPCError({
      code: "CONFLICT",
      message: "An entity named Ada already exists.",
      cause: {
        ...cause,
        opRef: "$op2",
        candidates: [{ ...cause.candidates[0], secret: "do-not-forward" }],
      },
    });
  }),
  wrapped: t.procedure.mutation(() => {
    const original = new TRPCError({
      code: "CONFLICT",
      message: "An entity named Ada already exists.",
      cause,
    });
    throw new TRPCError({
      code: "CONFLICT",
      message: "Couldn't apply — it conflicts with something that changed.",
      cause: original,
    });
  }),
  revision: t.procedure.mutation(() => {
    assertReviewedRevision(1, []);
  }),
});

interface TrpcErrorShape {
  message: string;
  data: {
    code: string;
    reasonCode?: string;
    candidates?: Array<{ id: string; title: string | null; type: string }>;
    opRef?: string;
    guidance?: string;
    [k: string]: unknown;
  };
}

async function call(path: string): Promise<TrpcErrorShape> {
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
  return superjson.deserialize<TrpcErrorShape>(raw.error);
}

describe("errorFormatter forwards ENTITY_WEAK_DEDUP only", () => {
  it("projects reasonCode and candidate ids, not guidance or extra fields", async () => {
    const error = await call("weak");
    expect(error.data.code).toBe("CONFLICT");
    expect(error.data.reasonCode).toBe("ENTITY_WEAK_DEDUP");
    expect(error.data.candidates).toEqual([
      { id: CANDIDATE, title: "Ada", type: "note" },
    ]);
    expect(error.data.guidance).toBeUndefined();
    expect(JSON.stringify(error.data)).not.toContain("guidance");
  });

  it("keeps opRef and drops fields that are not id/title/type", async () => {
    const error = await call("weakWithExtra");
    expect(error.data.reasonCode).toBe("ENTITY_WEAK_DEDUP");
    expect(error.data.opRef).toBe("$op2");
    expect(error.data.candidates).toEqual([
      { id: CANDIDATE, title: "Ada", type: "note" },
    ]);
    expect(JSON.stringify(error.data)).not.toContain("do-not-forward");
    expect(JSON.stringify(error.data)).not.toContain("secret");
  });

  it("reads the payload when safeApprovalError nests the original TRPCError", async () => {
    const error = await call("wrapped");
    expect(error.data.code).toBe("CONFLICT");
    expect(error.data.reasonCode).toBe("ENTITY_WEAK_DEDUP");
    expect(error.data.candidates?.[0]?.id).toBe(CANDIDATE);
  });

  it("a revision-guard CONFLICT is not labeled ENTITY_WEAK_DEDUP", async () => {
    let thrown: unknown;
    try {
      assertReviewedRevision(1, []);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe("CONFLICT");
    expect(readWeakDedupWire((thrown as TRPCError).cause)).toBeNull();
    expect(weakDedupFailureFields(thrown)).toEqual({});

    const error = await call("revision");
    expect(error.data.code).toBe("CONFLICT");
    expect(error.data.reasonCode).toBeUndefined();
    expect(error.data.candidates).toBeUndefined();
    expect(error.data.opRef).toBeUndefined();
    expect(error.message).toContain("changed since you reviewed it");
  });
});
