import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the `/health/dependencies` response literals are a CROSS-REPO
 * contract, string-matched by a consumer this repo cannot typecheck.
 *
 * `synap doctor` (synap-cli, `src/commands/doctor.ts`) hand-mirrors this
 * response shape — it does NOT import a generated type for this door — so the
 * pod's Zod schema and the CLI's literals are two independent copies with no
 * shared artifact between them. That has a specific, nasty failure mode:
 * rename `"intelligence-service"` or any `state` value here and BOTH repos'
 * test suites stay green (the CLI asserts itself against CLI-authored
 * fixtures), while in production doctor silently degrades to "could not
 * determine" and stops reporting a real IS outage. The rename is typed in
 * THIS repo, so the guard has to fail in THIS repo — a CLI-side test is
 * structurally incapable of catching it.
 *
 * Each state carries different user-facing remediation downstream, which is
 * why the enum cannot be quietly widened, narrowed, or collapsed to a boolean:
 *   reachable   → pass
 *   unreachable → fail, "restart/redeploy the IS" (URL known, probe failed)
 *   unresolved  → fail, "fix the config" (resolution itself failed — NEVER
 *                 phrased as an outage; the IS may never have been configured)
 *
 * If you intend to change any of these, that is a coordinated change: update
 * synap-cli in lockstep and tell whoever owns it. Do not just re-baseline this
 * test.
 */

const SOURCE = join(
  __dirname,
  "../routers/hub-protocol/rest/health-dependencies.ts"
);

/** Collapse whitespace so prettier reflowing the schema can't fail this. */
function normalized(): string {
  return readFileSync(SOURCE, "utf-8").replace(/\s+/g, " ");
}

describe("tripwire: /health/dependencies literals are a cross-repo contract", () => {
  it('keeps the dependency name literal "intelligence-service"', () => {
    expect(normalized()).toContain('name: z.literal("intelligence-service")');
  });

  it("keeps the state enum exactly [reachable, unreachable, unresolved]", () => {
    const src = normalized();
    const match = src.match(/state: z\.enum\(\[([^\]]*)\]\)/);
    expect(
      match,
      "state must stay a z.enum([...]) — a consumer branches on its string values"
    ).not.toBeNull();

    const members = [...match![1].matchAll(/"([a-z_-]+)"/g)].map((m) => m[1]);
    expect(members).toEqual(["reachable", "unreachable", "unresolved"]);
  });

  it("keeps `reachable` a boolean mirror alongside `state`", () => {
    // The CLI uses `state` for the verdict, but `reachable` is the documented
    // convenience bit. Dropping it silently breaks any consumer using it.
    expect(normalized()).toContain("reachable: z.boolean()");
  });

  it("keeps the route path stable", () => {
    // A moved path degrades doctor to its 404 "older build" branch — safe, but
    // it stops reporting real outages just as a rename would.
    expect(normalized()).toContain('path: "/health/dependencies"');
  });
});
