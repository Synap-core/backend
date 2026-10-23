/**
 * S7 — the Bearer tRPC door (`/api/hub/trpc`) fences MUTATIONS for scoped keys,
 * through the REAL `apiKeyMiddleware` on the REAL hub router.
 *
 * The key lookup and the identity / grant resolution are the two seams stubbed
 * (they read the database); everything after them — the fence, the scope check,
 * input parsing — is the served chain. A call the fence lets through fails
 * later on its missing input (BAD_REQUEST), never with a fence refusal, so the
 * outcome names which side of the fence the call landed on without running a
 * procedure body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const keyState = vi.hoisted(() => ({
  grant: null as unknown,
}));

vi.mock("../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      linkedUserId: null,
      keyName: "test",
      keyType: "user_pat",
      workspaceId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
    })),
    checkRateLimit: vi.fn(() => true),
  },
}));

vi.mock("../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: "22222222-2222-4222-8222-222222222222",
    agentUserId: undefined,
    grant: keyState.grant,
  })),
}));

import { z } from "zod";
import { hubProtocolRouter } from "../routers/hub-protocol/index.js";
import { router } from "../trpc.js";
import { scopedProcedure } from "./api-key-auth.js";
import {
  GRANT_DOOR_UNSUPPORTED,
  GRANT_OWNER_WIDE_UNSUPPORTED,
  GRANT_WRITE_DOOR_UNSUPPORTED,
} from "../access/grant-door-fence.js";
import {
  AI_READ_PROPOSE_ROLE_ID,
  GRANT_PRESETS,
} from "@synap-core/types/grants";

const AI = {
  scopes: [
    {
      permissions: GRANT_PRESETS.find((r) => r.id === AI_READ_PROPOSE_ROLE_ID)!
        .grant.permissions,
    },
  ],
  clientId: null,
};
const FULL = { scopes: [{ permissions: ["*"] }], clientId: null };
const STAR_ONE_WS = {
  scopes: [{ permissions: ["*"], workspaceIds: ["w1"] }],
  clientId: null,
};

/**
 * The served hub router plus ONE test-only mutation no row classifies — the
 * fail-closed path. Since W2a–W2d no live row is `refused`, so an unclassified
 * mutation is what a scoped key must still be fenced from.
 */
const fixture = router({
  fixture: router({
    unclassified: scopedProcedure(["hub-protocol.write"])
      .input(z.object({ x: z.string() }))
      .mutation(() => "ran"),
  }),
});

function bearerCaller(path: string): Record<string, unknown> {
  const req = new Request("http://pod.test/api/hub/trpc/x", {
    headers: { authorization: "Bearer sk_test" },
  });
  const served = path.startsWith("fixture.") ? fixture : hubProtocolRouter;
  return served.createCaller({
    req,
    authenticated: false,
  } as never) as unknown as Record<string, unknown>;
}

async function outcome(path: string): Promise<string> {
  const fn = path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown>)[k],
      bearerCaller(path)
    ) as (input: unknown) => Promise<unknown>;
  try {
    await fn(undefined);
    return "RESOLVED";
  } catch (err) {
    if (!(err instanceof TRPCError)) return `THREW: ${String(err)}`;
    if (err.code === "FORBIDDEN") {
      if (err.message === GRANT_OWNER_WIDE_UNSUPPORTED)
        return "FENCED:owner_wide";
      if (err.message === GRANT_WRITE_DOOR_UNSUPPORTED) return "FENCED:write";
      if (err.message === GRANT_DOOR_UNSUPPORTED) return "FENCED:read";
    }
    // Past the fence: the missing input fails validation.
    return err.code === "BAD_REQUEST" ? "PAST_FENCE" : `${err.code}`;
  }
}

describe("apiKeyMiddleware fences tRPC mutations for scoped keys (S7)", () => {
  beforeEach(() => {
    keyState.grant = null;
  });

  it("a scoped (AI preset) key: GATED passes, owner-wide / refused do not", async () => {
    keyState.grant = AI;
    expect(await outcome("documents.patchDocument")).toBe("PAST_FENCE");
    expect(await outcome("services.register")).toBe("FENCED:owner_wide");
    // Refused rows were fixed in W2a–W2d and flipped to GATED: the door
    // itself now bounds them (grant on the real target; D1 owner authority).
    expect(await outcome("entities.createEntity")).toBe("PAST_FENCE");
    expect(await outcome("automations.activateAutomation")).toBe("PAST_FENCE");
    // Fail closed: a mutation no row classifies is still fenced.
    expect(await outcome("fixture.unclassified")).toBe("FENCED:write");
    // Queries keep today's rule.
    expect(await outcome("entities.getEntities")).toBe("PAST_FENCE");
    expect(await outcome("search.search")).toBe("FENCED:read");
  });

  it("an unbounded `*` key passes every mutation", async () => {
    keyState.grant = FULL;
    for (const p of [
      "documents.patchDocument",
      "services.register",
      "entities.createEntity",
      "search.search",
      "fixture.unclassified",
    ]) {
      expect(await outcome(p), p).toBe("PAST_FENCE");
    }
  });

  it("a `*` pinned to a workspace is scoped: GATED only", async () => {
    keyState.grant = STAR_ONE_WS;
    expect(await outcome("documents.patchDocument")).toBe("PAST_FENCE");
    expect(await outcome("services.register")).toBe("FENCED:owner_wide");
    // GATED since W2a: the create door checks the pin on where the row lands.
    expect(await outcome("entities.createEntity")).toBe("PAST_FENCE");
    expect(await outcome("fixture.unclassified")).toBe("FENCED:write");
  });

  it("a key with no grant (legacy) is not fenced", async () => {
    keyState.grant = null;
    expect(await outcome("entities.createEntity")).toBe("PAST_FENCE");
    expect(await outcome("search.search")).toBe("PAST_FENCE");
    expect(await outcome("fixture.unclassified")).toBe("PAST_FENCE");
  });
});
