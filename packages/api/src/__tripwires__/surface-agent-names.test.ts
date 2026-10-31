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
 * HOW (derived, not hand-listed): read the harness registry's `surface` rows
 * (`SURFACE_HARNESS_SLUGS`, which `setup.ts` exports as `SURFACE_AGENT_TYPES`;
 * importing `setup.ts` would boot Kratos and the DB) and require each member
 * to be a KNOWN service id. A client added to the registry without a service
 * row fails here.
 *
 * WHAT IT DOES NOT SEE: `generic` is exempt by name — it is the "some other
 * client" bucket, not a product with a name of its own. That `setup.ts` really
 * exports the registry's list is `harness-registry.tripwire.test.ts`'s job.
 */
import { describe, expect, it } from "vitest";
import { SURFACE_HARNESS_SLUGS } from "@synap-core/types/agents";
import { normalizeServiceId } from "@synap-core/types/service-marks";

/** Not a product: the catch-all bucket for an unnamed client. */
const EXEMPT = new Set(["generic"]);

describe("SURFACE_AGENT_TYPES are named by the service registry", () => {
  const types: string[] = [...SURFACE_HARNESS_SLUGS];

  it("the scan still sees the allowlist (non-vacuity)", () => {
    expect(types).toContain("claude-code");
    expect(types.length).toBeGreaterThanOrEqual(6);
  });

  it.each(types.filter((t) => !EXEMPT.has(t)))("%s has a registry row", (t) => {
    expect(normalizeServiceId(t)).toBe(t);
  });
});
