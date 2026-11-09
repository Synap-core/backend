/**
 * Tripwire: a router does not call the bare global `fetch`, except where a
 * listed reason says why (finding e90aa057).
 *
 * The sibling `outbound-fetch-door.tripwire.test.ts` catches a URL that went
 * through `validateExternalUrl` and is then sent with the bare `fetch`. It
 * cannot see a URL that was checked ELSEWHERE, at the door that stored it:
 * registered intelligence-service URLs are text-checked when written
 * (`assertSafeServiceUrl`) and then fetched later, from another file, with
 * the service key. That is how `intelligence.ts` (8 calls) and
 * `capabilities.ts` (1) reached a DNS-rebound or sync-written address. They
 * now go through `fetchIntelligenceService` (`utils/intelligence-service-url.ts`).
 *
 * Rule, per production file under `packages/api/src/routers/` (derived by
 * globbing, so a new router joins by existing): the number of bare `fetch(...)`
 * calls (an identifier callee named `fetch`; `x.fetch(...)` is not counted)
 * equals the file's entry in KNOWN, and a file with no entry has none. KNOWN
 * is a ratchet with a reason per file: a new bare fetch anywhere fails; moving
 * one onto a door fails until its count is lowered here.
 *
 * What it does NOT cover, measured: granularity is a per-file COUNT, not the
 * call site (swapping one listed call for another unlisted one in the same
 * file stays green); `globalThis.fetch(...)` and an aliased fetch
 * (`const f = fetch`) are not seen; files outside `routers/` (services,
 * `@synap/intelligence-client`, jobs) are not scanned.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROUTERS = join(dirname(fileURLToPath(import.meta.url)), "../routers");

const IS_REMAINDER =
  "a resolved intelligence-service endpoint, not yet on fetchIntelligenceService: remainder of finding e90aa057";

/** Bare fetches that remain, per file, and why. Counts only fall. */
const KNOWN: Record<string, { count: number; reason: string }> = {
  "automations.ts": { count: 2, reason: IS_REMAINDER },
  "chat-stream.ts": { count: 1, reason: IS_REMAINDER },
  "mcp-servers.ts": { count: 2, reason: IS_REMAINDER },
  "hub-protocol/rest/capture.ts": { count: 1, reason: IS_REMAINDER },
  "hub-protocol/rest/health-dependencies.ts": {
    count: 1,
    reason: IS_REMAINDER,
  },
  "proposals/apply-approval.ts": { count: 1, reason: IS_REMAINDER },
  "external/openai-compat.ts": {
    count: 4,
    reason:
      "2 resolved IS endpoints (remainder of e90aa057), 1 custom AI provider baseUrl a person configured and OLLAMA_BASE_URL / the provider's model list: not yet on a door (follow-up of e90aa057)",
  },
  "cells.ts": {
    count: 1,
    reason: "the operator's CONTROL_PLANE_URL (configuration, not content)",
  },
  "hub-protocol/rest/cells.ts": {
    count: 1,
    reason: "the operator's CONTROL_PLANE_URL (configuration, not content)",
  },
  "hub-protocol/signals.ts": {
    count: 1,
    reason: "the operator's CONTROL_PLANE_URL source relay",
  },
  "channels/feed-query-plan.ts": {
    count: 1,
    reason: "the control plane relay URL the pod is linked to",
  },
  "workspaces/helpers.ts": {
    count: 2,
    reason: "the operator's CONTROL_PLANE_URL",
  },
  "system.ts": {
    count: 2,
    reason: "MINIO_ENDPOINT and the Kratos health URL from the operator's env",
  },
  "connectors-trpc.ts": {
    count: 4,
    reason:
      "2 probes of nango.<parent of PUBLIC_URL> (operator config), 2 fixed vendor hosts (api.apollo.io, api.apify.com)",
  },
};

function bareFetchCount(source: string): number {
  const file = ts.createSourceFile(
    "f.ts",
    source,
    ts.ScriptTarget.Latest,
    true
  );
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "fetch"
    ) {
      n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return n;
}

function routerFiles(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(ROUTERS, { recursive: true }) as string[]) {
    const parts = f.split(sep);
    if (
      f.endsWith(".ts") &&
      !f.endsWith(".d.ts") &&
      !/\.test\.ts$/.test(f) &&
      !parts.includes("__tests__") &&
      !parts.includes("__tripwires__")
    ) {
      out.push(join(ROUTERS, f));
    }
  }
  return out;
}

const key = (abs: string) => relative(ROUTERS, abs).split(sep).join("/");

describe("routers: no bare fetch outside the listed, reasoned remainder", () => {
  const files = routerFiles();
  const counts = new Map(
    files.map((f) => [key(f), bareFetchCount(readFileSync(f, "utf8"))])
  );

  it("scans a plausible set (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(100);
    // The routers that call the IS through the door must be in the scan.
    expect(counts.has("intelligence.ts")).toBe(true);
    expect(counts.has("capabilities.ts")).toBe(true);
    // Every KNOWN entry names a file that exists (a renamed file would
    // otherwise leave a stale allowance behind).
    for (const f of Object.keys(KNOWN)) expect(counts.has(f), f).toBe(true);
  });

  it("the counter sees a bare fetch and ignores a method or the door", () => {
    expect(bareFetchCount("await fetch(`${endpoint}/api/manifest`, {});")).toBe(
      1
    );
    expect(bareFetchCount("fetch(u).catch(() => fetch(v));")).toBe(2);
    expect(
      bareFetchCount(
        "await fetchIntelligenceService(u); await safePublicFetch(u); client.fetch(u); // fetch(x)"
      )
    ).toBe(0);
  });

  it("every router's bare fetch count equals its listed allowance", () => {
    const drift = [...counts]
      .map(([file, count]) => ({
        file,
        count,
        allowed: KNOWN[file]?.count ?? 0,
      }))
      .filter((d) => d.count !== d.allowed);
    expect(
      drift,
      "A NEW bare fetch: send a resolved service URL through fetchIntelligenceService, a content URL through safePublicFetch. A count that FELL: lower it in KNOWN."
    ).toEqual([]);
  });
});
