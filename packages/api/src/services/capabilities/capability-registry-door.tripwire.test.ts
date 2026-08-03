import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TRIPWIRE — the capability-BRICK catalogue door (`capabilities.registry.*`).
 *
 * These are source-shape assertions, not behaviour tests, because the two
 * invariants they protect are impossible to observe from a unit test (one needs
 * a live DB + tRPC ctx, the other is a cross-repo contract) and both are exactly
 * the kind of thing a later edit silently breaks:
 *
 *   1. ALTITUDE — the registry door must be `protectedProcedure`, never
 *      `workspaceProcedure`. A pod-level brick catalogue that requires a
 *      selected workspace 400s on the Capabilities app (`defaultScope: pod`).
 *      It is ALSO a cross-repo contract: `synap-app`'s
 *      `WORKSPACE_REQUIRED_PROCEDURES` tripwire re-derives the backend's
 *      `workspaceProcedure` set from these files and asserts exact equality, so
 *      a `workspaceProcedure` added here turns that test RED too.
 *
 *   2. LENS AUTHORIZATION — a caller-supplied `workspaceId` reaches the
 *      registry's `eq(workspaceId, …)` predicates. Without the
 *      `workspaceProcedure` middleware, NOTHING else verifies access, so every
 *      registry procedure must route its workspace input through
 *      `resolveRegistryLens`, which must check BOTH membership
 *      (`getWorkspaceRole`) and ownership (`ownedWorkspaceIds`) and throw
 *      FORBIDDEN when neither holds. This is the repo's documented owner-blind
 *      read defect class; a new read door is its prime candidate.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROUTER = readFileSync(join(SRC, "routers", "capabilities.ts"), "utf8");

/** The `capabilityRegistryRouter = router({ … })` body, brace-balanced. */
function registryRouterBody(): string {
  const start = ROUTER.indexOf("const capabilityRegistryRouter = router({");
  expect(start, "capabilityRegistryRouter must exist").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = ROUTER.indexOf("{", start); i < ROUTER.length; i++) {
    if (ROUTER[i] === "{") depth++;
    else if (ROUTER[i] === "}") {
      depth--;
      if (depth === 0) return ROUTER.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in capabilityRegistryRouter");
}

describe("capabilities.registry door", () => {
  const body = registryRouterBody();

  it("is mounted on the capabilities (brick) router, not on playbooks", () => {
    expect(ROUTER).toContain("registry: capabilityRegistryRouter");
    const playbooks = readFileSync(
      join(SRC, "routers", "playbooks.ts"),
      "utf8"
    );
    expect(playbooks).not.toContain("capabilityRegistryRouter");
  });

  it("exposes the sectioned catalogue and the create-verb door", () => {
    expect(body).toContain("sections: protectedProcedure");
    expect(body).toContain("createVerb: protectedProcedure");
  });

  it("uses NO workspaceProcedure — the catalogue is pod-altitude", () => {
    expect(body).not.toContain("workspaceProcedure");
    expect(body).not.toContain("workspaceMutationProcedure");
  });

  it("routes every workspace input through resolveRegistryLens", () => {
    const procedures = body
      .split(/\n  (?=[a-zA-Z]+: protectedProcedure)/)
      .filter((p) => p.includes(": protectedProcedure"));
    expect(procedures.length).toBeGreaterThanOrEqual(2);
    for (const p of procedures) {
      expect(
        p.includes("resolveRegistryLens"),
        `registry procedure must authorize its workspace lens:\n${p.slice(0, 200)}`
      ).toBe(true);
    }
  });

  it("resolveRegistryLens authorizes membership OR ownership and throws FORBIDDEN", () => {
    const start = ROUTER.indexOf("async function resolveRegistryLens");
    expect(start).toBeGreaterThan(-1);
    const fn = ROUTER.slice(start, ROUTER.indexOf("\n}", start));
    // Two arms, because `workspaces.owner_id` is a first-class column SEPARATE
    // from `workspace_members`: a sovereign pod's owner may have no member row,
    // and a membership-only gate hard-FORBIDs them from their own catalogue.
    expect(fn).toContain("getWorkspaceRole"); // membership arm
    expect(fn).toContain("ownedWorkspaceIds"); // ownership arm
    // …and neither arm may be advisory: a caller with neither is still refused.
    expect(fn).toContain("FORBIDDEN");
    // Pod altitude is `null`, never a silent fall-through to some other lens.
    expect(fn).toContain("return null");
  });

  it("createVerb delegates to the governed skills door — no direct insert", () => {
    const start = body.indexOf("createVerb: protectedProcedure");
    const createVerb = body.slice(start);
    expect(createVerb).toContain("skillsRouter");
    expect(createVerb).toContain("validateCreateVerbInput");
    expect(createVerb).toContain("parentToolWhere");
    expect(createVerb).not.toContain("db.insert");
    expect(createVerb).not.toContain("database.insert");
    // A human caller: governance must NOT be told an agent did this.
    expect(createVerb).not.toContain("agentUserId:");
  });
});
