/**
 * TRIPWIRE — `skills.setRequiredTools` (an ungoverned protectedProcedure that
 * rewrites a skill's `requires` edges, i.e. the scope its own provider calls
 * skip a second review under) is NOT reachable with an API key.
 *
 * The answer this pins (review of #199, M4), door by door:
 *  - main `/trpc`: every non-public procedure needs a Kratos SESSION
 *    (`apps/api/src/trpc-session-gate.ts`, tested there) — a key cannot call it;
 *  - hub tRPC (`/api/hub/trpc`, key auth) serves `hubProtocolRouter`, which has
 *    no such procedure (asserted below, from the router's own procedure map);
 *  - hub REST and MCP handlers: no source calls it (scan below). The REST
 *    `POST /skills` `requires` now rides the governed create as
 *    `requiredToolIds` instead.
 * So only a signed-in person reaches it. Server-side callers that are not
 * key doors (`wireCreatedVerb`, the definition applier) are not scanned.
 *
 * Negative control (2026-10-25): re-adding the old REST post-create
 * `caller.setRequiredTools(...)` turns the scan red.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
});

import { hubProtocolRouter } from "../routers/hub-protocol/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_DOOR_DIRS = [
  resolve(HERE, "../routers/hub-protocol/rest"),
  resolve(HERE, "../routers/mcp/handlers"),
];
const CALL = /\.setRequiredTools\(/;

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    if (!e.name.endsWith(".ts") || e.name.includes(".test.")) return [];
    return [{ file: p, text: readFileSync(p, "utf8") }];
  });
}

describe("tripwire: an API key cannot reach skills.setRequiredTools", () => {
  it("the key-auth hub tRPC router has no setRequiredTools procedure", () => {
    const procedures = Object.keys(
      (hubProtocolRouter as unknown as { _def: { procedures: object } })._def
        .procedures
    );
    // Non-vacuity: it is the real router, with its skills namespace.
    expect(procedures.length).toBeGreaterThan(50);
    expect(procedures.some((p) => p.startsWith("skills."))).toBe(true);
    expect(procedures.filter((p) => p.endsWith("setRequiredTools"))).toEqual(
      []
    );
  });

  it("no hub REST route or MCP handler calls it", () => {
    const files = KEY_DOOR_DIRS.flatMap(sources);
    // Non-vacuity: both trees were read, and the scan sees a literal call.
    expect(files.length).toBeGreaterThan(30);
    expect(CALL.test("await caller.setRequiredTools({ skillId })")).toBe(true);
    expect(files.filter((f) => CALL.test(f.text)).map((f) => f.file)).toEqual(
      []
    );
  });
});
