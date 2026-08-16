import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The `runs` router's `flowType` input enum MUST mirror the domain `FlowType`.
 *
 * They drifted, and the drift shipped: `agent_write` was deliberately added to
 * the domain type (`services/runs/types.ts`) — "the CATCH-ALL for a plain agent
 * write that instantiates no flow at all… before this member existed it rendered
 * in NO flow type and was invisible in the unified feed" — and `getRun` grew a
 * complete `agent_write` branch that resolves the run and joins its
 * correlationId events. The unified feed listed those runs. But the router's
 * Zod input enum was never widened, so `runs.get` 400'd on the very kind the
 * service could serve: click an agent-write run in the feed and the detail door
 * refused it. The door was narrower than the room behind it.
 *
 * That is this repo's most repeated defect — runtime-matches ≠ door-accepts,
 * where a producer is extended and its consumer is not, and nothing fails until
 * a human clicks the exact path. It is only catchable structurally, because both
 * sides typecheck perfectly on their own.
 *
 * Parsed from source rather than imported: the Zod enum is a module-private
 * `const` inside the router, and importing the router drags in the whole tRPC +
 * DB graph for what is a two-list comparison.
 */

const API_SRC = join(__dirname, "..");

function readSource(relative: string): string {
  return readFileSync(join(API_SRC, relative), "utf8");
}

/** Members of the `export type FlowType = "a" | "b" | …` union. */
function domainFlowTypes(): string[] {
  const src = readSource("services/runs/types.ts");
  const decl = /export type FlowType\s*=([\s\S]*?);/.exec(src);
  expect(
    decl,
    "could not find `export type FlowType` in services/runs/types.ts"
  ).not.toBeNull();
  return [...decl![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

/** Members of the router's `const flowType = z.enum([...])`. */
function routerFlowTypes(): string[] {
  const src = readSource("routers/runs.ts");
  const decl = /const flowType = z\.enum\(\[([\s\S]*?)\]\)/.exec(src);
  expect(
    decl,
    "could not find `const flowType = z.enum([...])` in routers/runs.ts"
  ).not.toBeNull();
  return [...decl![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
}

describe("tripwire: runs router flowType mirrors the domain FlowType", () => {
  it("parses a non-trivial member list from BOTH sides", () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously true.
    expect(domainFlowTypes().length).toBeGreaterThan(3);
    expect(routerFlowTypes().length).toBeGreaterThan(3);
  });

  it("accepts every flow type the domain defines", () => {
    const missing = domainFlowTypes().filter(
      (t) => !routerFlowTypes().includes(t)
    );
    expect(
      missing,
      `runs.get/list reject flow type(s) the domain defines and getRun can serve: ${missing.join(", ")}. Widen the z.enum in routers/runs.ts.`
    ).toEqual([]);
  });

  it("accepts nothing the domain does not define", () => {
    const extra = routerFlowTypes().filter(
      (t) => !domainFlowTypes().includes(t)
    );
    expect(
      extra,
      `the router accepts flow type(s) with no domain meaning: ${extra.join(", ")}. Either add them to FlowType or drop them from the router.`
    ).toEqual([]);
  });

  it("agent_write specifically is accepted (the member that shipped broken)", () => {
    expect(domainFlowTypes()).toContain("agent_write");
    expect(routerFlowTypes()).toContain("agent_write");
  });
});
