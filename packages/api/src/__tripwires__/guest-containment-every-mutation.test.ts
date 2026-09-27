/**
 * TRIPWIRE — a signed-in GUEST can call NO tRPC mutation except the explicit
 * allowlist (`GUEST_MUTATION_ALLOWLIST`, access/guest-containment.ts).
 *
 * Why: a guest only reads what an owner shared. Before the containment, any
 * write door that minted participation (`workspaces.create` writes an owned
 * workspace, and "owns a workspace" IS participation) turned a guest into a pod
 * reader. A per-router check would leave the next router open, so the refusal
 * sits on `publicProcedure`, which every procedure is built from.
 *
 * DERIVED, BEHAVIOURAL: the mutation set is read from the SERVED router
 * (`coreRouter._def.procedures`, filtered on `_def.type`), never hand-listed, and
 * every mutation is actually CALLED as a guest, through a context built by the
 * real `createContext` (the factory both tRPC HTTP mounts use). The audience
 * probe is the one seam stubbed (`AccessContext.prototype.audience` → "guest");
 * the refusal runs before input parsing, so no procedure body or database is
 * reached. A new
 * mutation joins the scan by existing; one built on a base that skips the guard
 * fails here.
 *
 * NOT COVERED (measured by reading, not by a mutant): a procedure whose
 * principal is set by a LATER middleware (the Bearer path of
 * `apiKeyProcedure`) — this caller hands the principal in the context, so the
 * base guard already sees it. `apiKeyProcedure` re-applies the guard after
 * `apiKeyMiddleware` for that case.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { coreRouter } from "../root.js";
import { createContext } from "../context.js";
import { AccessContext } from "../access/context.js";
import {
  GUEST_MUTATION_ALLOWLIST,
  GUEST_REFUSED_MESSAGE,
} from "../access/guest-containment.js";

const GUEST = "0b9d6f3e-1c2a-4e5f-8a7b-9c0d1e2f3a4b";

type AnyProcedure = { _def: { type?: string } };
const procedures = coreRouter._def.procedures as unknown as Record<
  string,
  AnyProcedure
>;
const mutations = Object.entries(procedures)
  .filter(([, p]) => p._def.type === "mutation")
  .map(([path]) => path)
  .sort();

// The context comes from the REAL factory both tRPC HTTP mounts use, so the
// seam under test is the served one: `createContext` marks the request, the
// guard judges marked requests.
let guestCaller: Record<string, unknown>;
async function servedContextFor(userId: string) {
  return createContext(new Request("http://pod.test/trpc/batch"), {
    get: (key: string) =>
      key === "session"
        ? { identity: { id: userId, traits: { email: `${userId}@x.test` } } }
        : undefined,
  });
}

function callerFor(path: string): (input: unknown) => Promise<unknown> {
  const fn = path
    .split(".")
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], guestCaller);
  return fn as (input: unknown) => Promise<unknown>;
}

async function outcome(path: string): Promise<string> {
  try {
    await callerFor(path)(undefined);
    return "RESOLVED";
  } catch (err) {
    if (err instanceof TRPCError) {
      return err.code === "FORBIDDEN" && err.message === GUEST_REFUSED_MESSAGE
        ? "GUEST_REFUSED"
        : `${err.code}: ${err.message.slice(0, 80)}`;
    }
    return `THREW: ${String(err).slice(0, 80)}`;
  }
}

let audienceSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  audienceSpy = vi
    .spyOn(AccessContext.prototype, "audience")
    .mockResolvedValue("guest");
  guestCaller = coreRouter.createCaller(
    (await servedContextFor(GUEST)) as never
  ) as unknown as Record<string, unknown>;
});
afterAll(() => audienceSpy.mockRestore());

describe("tripwire: guest containment covers every tRPC mutation", () => {
  it("the scan sees the served router's mutations (non-vacuity)", () => {
    // Measured 2026-09-27: several hundred. A collapse means the scan went blind.
    expect(mutations.length).toBeGreaterThan(300);
    for (const sample of [
      "workspaces.create",
      "apiKeys.create",
      "relations.update",
      "entities.update",
      "shares.redeemLink",
    ]) {
      expect(mutations).toContain(sample);
    }
  });

  it("every non-allowlisted mutation refuses a guest, before its body runs", async () => {
    const escaped: string[] = [];
    for (const path of mutations) {
      if (GUEST_MUTATION_ALLOWLIST.includes(path)) continue;
      const got = await outcome(path);
      if (got !== "GUEST_REFUSED") escaped.push(`${path} → ${got}`);
    }
    expect(escaped).toEqual([]);
  });

  it("every allowlist entry is a registered mutation that the guard lets through", async () => {
    for (const path of GUEST_MUTATION_ALLOWLIST) {
      expect(mutations, `${path} is not a registered mutation`).toContain(path);
      // Past the guard, the missing input fails validation instead.
      expect(await outcome(path)).not.toBe("GUEST_REFUSED");
    }
  });

  it("a query is never refused by the guard (reads go through the floors)", async () => {
    const got = await outcome("relations.get");
    expect(got).not.toBe("GUEST_REFUSED");
  });

  it("the verdict comes from the audience probe: a member is let through", async () => {
    audienceSpy.mockResolvedValueOnce("member");
    const memberCaller = coreRouter.createCaller(
      (await servedContextFor("5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d")) as never
    ) as unknown as {
      workspaces: { create: (i: unknown) => Promise<unknown> };
    };
    let message = "RESOLVED";
    try {
      await memberCaller.workspaces.create(undefined);
    } catch (err) {
      message = (err as Error).message;
    }
    // Past the guard the call fails later (split-brain probe / validation), but
    // never with the guest refusal.
    expect(message).not.toBe(GUEST_REFUSED_MESSAGE);
    expect(audienceSpy).toHaveBeenCalled();
  });
});
