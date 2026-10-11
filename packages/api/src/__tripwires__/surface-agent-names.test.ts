/**
 * TRIPWIRE — every AI client a computer can host is NAMED by the one registry.
 *
 * WHY (MACHINE-IDENTITY-PLAN W2 → W3). The device door names an agent
 * "<client> on <computer>" through `resolveServiceName(agentType)`. The
 * registry had no row for any AI client, so the unknown-id fallback humanized
 * the id and pod-admin `/device` would have asked a person to approve
 * "Claude code on devbox". The fallback never leaks a raw token — which is
 * exactly why the miss was silent.
 *
 * HOW (derived, not hand-listed): read `SURFACE_AGENT_TYPES` out of the
 * device/setup door's SOURCE (importing `setup.ts` would boot Kratos and the
 * DB) and require each member to be a KNOWN service id. A client added to the
 * allowlist without a registry row fails here.
 *
 * WHAT IT DOES NOT SEE: `generic` is exempt by name — it is the "some other
 * client" bucket, not a product with a name of its own. The scan reads the
 * literal array; a list built from a variable would be invisible, and the
 * non-vacuity floor below is what notices the regex going blind.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeServiceId } from "@synap-core/types/service-marks";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, "../routers/hub-protocol/rest/setup.ts");

/** Not a product: the catch-all bucket for an unnamed client. */
const EXEMPT = new Set(["generic"]);

function surfaceAgentTypes(): string[] {
  const src = readFileSync(SETUP, "utf8");
  const m = src.match(
    /export const SURFACE_AGENT_TYPES = \[([\s\S]*?)\] as const;/
  );
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("SURFACE_AGENT_TYPES are named by the service registry", () => {
  const types = surfaceAgentTypes();

  it("the scan still sees the allowlist (non-vacuity)", () => {
    expect(types).toContain("claude-code");
    expect(types.length).toBeGreaterThanOrEqual(6);
  });

  it.each(types.filter((t) => !EXEMPT.has(t)))("%s has a registry row", (t) => {
    expect(normalizeServiceId(t)).toBe(t);
  });
});
