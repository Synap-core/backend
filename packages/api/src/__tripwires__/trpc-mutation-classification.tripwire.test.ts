/**
 * TRIPWIRE — every key-reachable tRPC MUTATION is classified for scoped keys (S7).
 *
 * The Bearer tRPC door (`apiKeyMiddleware`) lets a scoped key through a
 * mutation only when `TRPC_KEY_MUTATION_DOORS` (access/grant-door-fence.ts)
 * says the gate bounds it (`gated`); anything else — owner-wide, refused, or
 * UNCLASSIFIED — needs an unbounded `*` key. Unclassified is fail-closed, so a
 * forgotten row breaks a scoped caller instead of opening a hole; this test
 * makes the omission fail CI first.
 *
 * DERIVED, never hand-listed. The key-reachable set is read from the SERVED
 * routers:
 *   - `hubProtocolRouter._def.procedures` (mounted at /api/hub/trpc): every
 *     non-query procedure;
 *   - `coreRouter._def.procedures` (main /trpc): every procedure whose
 *     middleware chain contains `apiKeyMiddleware`'s function (identity), so a
 *     new key procedure on ANY core router joins the scan by existing.
 *
 * Defeat checks run here on FIXTURE routers (the live ones merged with a
 * test-only mutation), never on production code.
 *
 * NOT COVERED (stated): whether a `gated` row really gates the right target is
 * a code-reading claim (plan §1.2); each W2 root fix proves its row with a
 * PGlite test before flipping it. The in-process callers (Hub REST getCaller,
 * MCP createCaller) take the middleware's short-circuit and are not fenced by
 * this table yet (plan §3.2, W3).
 */
import { describe, expect, it } from "vitest";
import { coreRouter } from "../root.js";
import { hubProtocolRouter } from "../routers/hub-protocol/index.js";
import {
  apiKeyMiddleware,
  scopedProcedure,
} from "../middleware/api-key-auth.js";
import { mergeRouters, protectedProcedure, router } from "../trpc.js";
import {
  GRANT_SAFE_TRPC_QUERIES,
  TRPC_KEY_MUTATION_DOORS,
} from "../access/grant-door-fence.js";

type AnyProcedure = { _def: { type?: string; middlewares?: unknown[] } };
type AnyRouter = {
  _def: { procedures: unknown; lazy?: Record<string, unknown> };
};

const KEY_MW = (apiKeyMiddleware as unknown as { _middlewares: unknown[] })
  ._middlewares;

function procs(r: AnyRouter): Array<[string, AnyProcedure]> {
  return Object.entries(r._def.procedures as Record<string, AnyProcedure>);
}

function isKeyProcedure(p: AnyProcedure): boolean {
  return (p._def.middlewares ?? []).some((m) => KEY_MW.includes(m));
}

/** Every key-reachable procedure path, split by type. */
function keyReachable(hub: AnyRouter, core: AnyRouter) {
  const mutations = new Set<string>();
  const queries = new Set<string>();
  for (const [path, p] of procs(hub)) {
    (p._def.type === "query" ? queries : mutations).add(path);
  }
  for (const [path, p] of procs(core)) {
    if (!isKeyProcedure(p)) continue;
    (p._def.type === "query" ? queries : mutations).add(path);
  }
  return { mutations, queries };
}

function unclassified(
  mutations: Set<string>,
  table: Readonly<Record<string, unknown>>
): string[] {
  return [...mutations].filter((p) => !(p in table)).sort();
}

const live = keyReachable(
  hubProtocolRouter as unknown as AnyRouter,
  coreRouter as unknown as AnyRouter
);
const hubMutations = procs(hubProtocolRouter as unknown as AnyRouter).filter(
  ([, p]) => p._def.type !== "query"
);
const coreKeyMutations = procs(coreRouter as unknown as AnyRouter).filter(
  ([, p]) => isKeyProcedure(p) && p._def.type !== "query"
);

describe("tripwire: every key-reachable tRPC mutation is classified (S7)", () => {
  it("the scan sees the served routers (non-vacuity)", () => {
    // A lazy router's procedures are not in `_def.procedures` until loaded —
    // the scan would go blind to it.
    expect(
      Object.keys((hubProtocolRouter as unknown as AnyRouter)._def.lazy ?? {})
    ).toEqual([]);
    expect(
      Object.keys((coreRouter as unknown as AnyRouter)._def.lazy ?? {})
    ).toEqual([]);
    // The middleware identity resolves (one function behind apiKeyMiddleware).
    expect(KEY_MW.length).toBeGreaterThan(0);
    // Measured 2026-10-20: 57 hub mutations, 3 core key mutations.
    expect(hubMutations.length).toBeGreaterThanOrEqual(57);
    expect(coreKeyMutations.length).toBeGreaterThanOrEqual(3);
    for (const sample of [
      "entities.createEntity",
      "services.register",
      "automations.triggerAutomation",
      "n8nActions.createEntity",
      "intelligenceRegistry.storeServiceSecret",
    ]) {
      expect([...live.mutations]).toContain(sample);
    }
    // Every hub procedure is built on the key middleware (bar the public
    // health query), so the core-router identity test is the same door.
    expect(
      hubMutations.filter(([, p]) => !isKeyProcedure(p)).map(([n]) => n)
    ).toEqual([]);
  });

  it("classifies every key-reachable mutation", () => {
    expect(
      unclassified(live.mutations, TRPC_KEY_MUTATION_DOORS),
      "Classify the mutation in TRPC_KEY_MUTATION_DOORS (access/grant-door-fence.ts). " +
        "Until then every scoped key gets 403 on it."
    ).toEqual([]);
  });

  it("has no stale row: every row is a live key-reachable mutation", () => {
    expect(
      Object.keys(TRPC_KEY_MUTATION_DOORS)
        .filter((p) => !live.mutations.has(p))
        .sort()
    ).toEqual([]);
  });

  it("every seamed query is a live key-reachable query", () => {
    expect(
      [...GRANT_SAFE_TRPC_QUERIES].filter((p) => !live.queries.has(p)).sort()
    ).toEqual([]);
  });

  describe("defeat checks (fixture routers, never production code)", () => {
    it("a test-only mutation added to the hub router is caught", () => {
      const fixtureHub = mergeRouters(
        hubProtocolRouter,
        router({
          zzTripwireFixture: router({
            probe: scopedProcedure(["hub-protocol.write"]).mutation(() => null),
          }),
        })
      );
      const got = keyReachable(
        fixtureHub as unknown as AnyRouter,
        coreRouter as unknown as AnyRouter
      );
      expect(unclassified(got.mutations, TRPC_KEY_MUTATION_DOORS)).toEqual([
        "zzTripwireFixture.probe",
      ]);
    });

    it("a test-only KEY mutation on a core router is caught; a session one is not", () => {
      const fixtureCore = mergeRouters(
        coreRouter,
        router({
          zzTripwireFixture: router({
            keyProbe: scopedProcedure(["hub-protocol.write"]).mutation(
              () => null
            ),
            sessionProbe: protectedProcedure.mutation(() => null),
          }),
        })
      );
      const got = keyReachable(
        hubProtocolRouter as unknown as AnyRouter,
        fixtureCore as unknown as AnyRouter
      );
      expect(unclassified(got.mutations, TRPC_KEY_MUTATION_DOORS)).toEqual([
        "zzTripwireFixture.keyProbe",
      ]);
    });

    it("removing a row is caught", () => {
      const { ["services.register"]: _removed, ...withoutOne } =
        TRPC_KEY_MUTATION_DOORS;
      expect(unclassified(live.mutations, withoutOne)).toEqual([
        "services.register",
      ]);
    });
  });
});
