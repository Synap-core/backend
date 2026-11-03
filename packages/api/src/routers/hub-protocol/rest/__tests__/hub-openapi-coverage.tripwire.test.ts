/**
 * HUB OPENAPI COVERAGE (hub schema drift finder, R0).
 *
 * `registerOpenApi` is documentation only and a plain `app.get` is documented
 * nowhere, so the spec drifts from what the pod serves: ~176 served routes had
 * no operation, 14 spec paths wrote `:id` (not an OpenAPI template), and 54 of
 * 309 2xx responses had no schema. This tripwire derives the SERVED set from
 * the real app (never a hand list) and pins:
 *   1. every served route is in docs/reference/hub-openapi.json (what clients
 *      read), except a shrink-only baseline;
 *   2. no registered or committed spec path contains `:`;
 *   3. app-facing (grant fence SAFE / NARROWED) routes have a described 2xx,
 *      except a shrink-only baseline.
 * Each baseline is exact in both directions: a new gap fails, and a fixed one
 * must be deleted. The response BODIES are checked by the test-only middleware
 * (`_test-support/hub-response-check.ts`), see hub-response-drift.tripwire.test.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hubProtocolRestApp } from "../../../hub-protocol-rest.js";
import { toOpenApiPath } from "../_codecs/_register.js";
import {
  APP_FACING_OPEN_RESPONSES,
  HUB_ROUTES_MISSING_FROM_SPEC,
} from "../_test-support/hub-openapi-coverage.baseline.js";
import {
  GRANT_REST_GET_READS,
  GRANT_REST_POST_READS,
  GRANT_SAFE_REST_READS,
} from "../../../../access/grant-door-fence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_FILE = join(
  HERE,
  "../../../../../../../docs/reference/hub-openapi.json"
);
const METHODS = ["get", "post", "put", "patch", "delete"];

/** Every `METHOD /path` the app serves (middleware `ALL` and wildcards out). */
function servedRoutes(): string[] {
  const set = new Set<string>();
  for (const r of hubProtocolRestApp.routes) {
    const method = r.method.toLowerCase();
    if (!METHODS.includes(method) || r.path.includes("*")) continue;
    set.add(`${method.toUpperCase()} ${toOpenApiPath(r.path)}`);
  }
  return [...set].sort();
}

type Def = {
  type: string;
  route?: {
    method: string;
    path: string;
    responses?: Record<string, { content?: Record<string, { schema?: any }> }>;
  };
};

function registeredRoutes() {
  return (hubProtocolRestApp.openAPIRegistry.definitions as Def[]).filter(
    (d) => d.type === "route" && d.route
  );
}

const keyOf = (method: string, path: string) =>
  `${method.toUpperCase()} ${toOpenApiPath(path)}`;

/** The committed spec (`pnpm docs:reference`; CI's "Reference docs are current" pins it to the registry). */
const spec = JSON.parse(readFileSync(SPEC_FILE, "utf8")) as {
  paths: Record<string, Record<string, any>>;
};

/** Today's sizes; lower one when an entry is deleted, never raise it. */
const MISSING_CEILING = 181;
const OPEN_CEILING = 13;

describe("hub openapi coverage", () => {
  const served = servedRoutes();
  const registry = registeredRoutes();
  const documented = new Set(
    Object.entries(spec.paths).flatMap(([p, ops]) =>
      Object.keys(ops)
        .filter((m) => METHODS.includes(m))
        .map((m) => keyOf(m, p))
    )
  );
  const missing = served.filter((k) => !documented.has(k));

  it("derives a real served set (non-vacuous)", () => {
    expect(served.length).toBeGreaterThanOrEqual(300);
    // a literal sample, so a harvest that silently narrows is caught
    expect(served).toContain("GET /orient");
    expect(served).toContain("GET /focus-sessions/{id}");
    expect(documented.size).toBeGreaterThanOrEqual(250);
    expect(documented).toContain("GET /focus-sessions/{id}");
  });

  it("every served route is in hub-openapi.json, except the shrink-only baseline", () => {
    const baseline = new Set(HUB_ROUTES_MISSING_FROM_SPEC);
    const fresh = missing.filter((k) => !baseline.has(k));
    expect(
      fresh,
      "served but not in docs/reference/hub-openapi.json: register it with registerOpenApi (or app.openapi), then `pnpm docs:reference`"
    ).toEqual([]);
    const fixed = [...baseline].filter((k) => !missing.includes(k));
    expect(
      fixed,
      "now documented (or no longer served): delete it from HUB_ROUTES_MISSING_FROM_SPEC and lower MISSING_CEILING"
    ).toEqual([]);
  });

  it("the baselines only shrink", () => {
    expect(HUB_ROUTES_MISSING_FROM_SPEC.length).toBeLessThanOrEqual(
      MISSING_CEILING
    );
    expect(APP_FACING_OPEN_RESPONSES.length).toBeLessThanOrEqual(OPEN_CEILING);
    expect(new Set(HUB_ROUTES_MISSING_FROM_SPEC).size).toBe(
      HUB_ROUTES_MISSING_FROM_SPEC.length
    );
    expect(new Set(APP_FACING_OPEN_RESPONSES).size).toBe(
      APP_FACING_OPEN_RESPONSES.length
    );
  });

  it("no spec path is written with a Hono `:param`", () => {
    const registeredPaths = registry.map((d) => d.route!.path);
    // as registered ('{id}', never ':id') AND as committed in docs/reference
    expect(registeredPaths.filter((p) => p.includes(":"))).toEqual([]);
    expect(Object.keys(spec.paths).filter((p) => p.includes(":"))).toEqual([]);
    expect(registeredPaths.length).toBeGreaterThan(250);
  });

  it("app-facing SAFE / NARROWED routes describe their 2xx, except the baseline", () => {
    const isOpen = (schema: any): boolean => {
      if (!schema) return true;
      const keys = Object.keys(schema);
      if (keys.length === 0) return true;
      if (
        schema.$ref ||
        schema.allOf ||
        schema.anyOf ||
        schema.oneOf ||
        schema.items
      )
        return false;
      if (schema.type && schema.type !== "object") return false;
      return (
        Object.keys(schema.properties ?? {}).length === 0 &&
        schema.additionalProperties === undefined
      );
    };
    const appFacing = (method: string, path: string) => {
      // `{id}` -> a concrete segment, as the fence regexes see real paths
      const concrete = path.replace(/\{[^}]+\}/g, "x");
      if (method === "GET")
        return (
          GRANT_SAFE_REST_READS.some((r) => r.test(concrete)) ||
          GRANT_REST_GET_READS.some(([r]) => r.test(concrete))
        );
      if (method === "POST")
        return GRANT_REST_POST_READS.some(([r]) => r.test(concrete));
      return false;
    };
    const facing = served.filter((k) => {
      const [m, p] = k.split(" ");
      return appFacing(m, p);
    });
    expect(facing.length).toBeGreaterThanOrEqual(20); // non-vacuous
    const open = facing.filter((k) => {
      const [m, p] = k.split(" ");
      const op = spec.paths[p]?.[m.toLowerCase()];
      if (!op) return true;
      const ok = Object.entries(op.responses ?? {}).some(
        ([code, r]: [string, any]) =>
          /^2/.test(code) && !isOpen(r?.content?.["application/json"]?.schema)
      );
      return !ok;
    });
    if (process.env.HUB_COVERAGE_DUMP)
      console.log(
        `HUB_COVERAGE_DUMP ${JSON.stringify({ missing, open }, null, 2)}`
      );
    const baseline = new Set(APP_FACING_OPEN_RESPONSES);
    expect(
      open.filter((k) => !baseline.has(k)),
      "app-facing route without a described 2xx response"
    ).toEqual([]);
    expect(
      [...baseline].filter((k) => !open.includes(k)),
      "now described: delete it from APP_FACING_OPEN_RESPONSES and lower OPEN_CEILING"
    ).toEqual([]);
  });
});
