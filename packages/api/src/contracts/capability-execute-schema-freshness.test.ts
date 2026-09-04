import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCapabilityExecuteJsonSchema } from "./capability-execute-schema.js";
import {
  CLIENT_SUPPLIED_PARAMS,
  SERVER_DERIVED_PARAMS,
} from "./capability-execute.js";

/**
 * TRIPWIRE — the committed capability-execute JSON Schema is FRESH.
 *
 * Same shape of guard, and the same reason, as
 * `routers/mcp/tools/manifest-freshness.test.ts`: a committed artifact
 * generated from a source of truth is a projection, and a projection with
 * nothing forcing it to track its source is the defect this repo keeps finding.
 *
 * The chain here is
 *
 *     contracts/capability-execute.ts  →  generated/capability-execute.schema.json
 *                                      →  the Intelligence Service's run_capability tool
 *
 * The Intelligence Service is pinned to zod 3 and cannot import the zod-4
 * contract, so the artifact is its ONLY honest source. A stale artifact means
 * the IS advertises a capability-run contract the pod no longer has — and
 * because that door is agent-facing, the failure mode is an agent that cannot
 * say `sessionId` and a run that lands unattributed, which is exactly the 2.6%
 * session-provenance hole this contract exists to close.
 *
 * FIX WHEN RED:  cd packages/api && pnpm gen:capability-schema
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = resolve(__dirname, "generated/capability-execute.schema.json");

describe("tripwire: the capability-execute JSON Schema artifact is generated, not maintained", () => {
  const committed = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    properties?: Record<string, unknown>;
  };

  it("reads a real artifact — this test is not passing over nothing", () => {
    expect(
      Object.keys(committed.properties ?? {}).length,
      "the artifact declares no properties; the file or the generator shape changed"
    ).toBeGreaterThanOrEqual(8);
  });

  it("the committed artifact matches what the contract generates today", () => {
    expect(
      committed,
      "The committed JSON Schema is STALE — the zod contract changed and the " +
        "artifact the Intelligence Service reads did not. Regenerate it:\n" +
        "  cd packages/api && pnpm gen:capability-schema"
    ).toEqual(buildCapabilityExecuteJsonSchema());
  });

  it("publishes every CLIENT-suppliable parameter and no server-derived one", () => {
    const published = Object.keys(committed.properties ?? {});
    expect(
      published.sort(),
      "the artifact must publish exactly the contract's client-suppliable keys"
    ).toEqual([...CLIENT_SUPPLIED_PARAMS].sort());
    // Identity and the governance suppressor must never become client fields.
    // Publishing `userId`/`agentUserId` would advertise an impersonation door;
    // publishing `suppressProposal` would advertise a way to opt out of review.
    const leaked = SERVER_DERIVED_PARAMS.filter((p) => published.includes(p));
    expect(
      leaked,
      `These parameters are server-derived and must NEVER appear in a client ` +
        `contract: ${leaked.join(", ")}`
    ).toEqual([]);
  });
});
