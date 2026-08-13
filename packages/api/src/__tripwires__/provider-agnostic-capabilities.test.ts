import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { providerTemplateKey } from "../connectors/materialize-tools.js";

/**
 * WAVE-6 invariants:
 *   (a) adding a provider must NOT require a code change — the template key
 *       follows the `nango-<provider>` convention, with the map as override-only.
 *   (b) agents must be able to tell "connected" from "needs connection" — the
 *       capability read-model carries a `connection` field for provider tools and
 *       the MCP runnable projection gates `enabled` on it.
 */

const registrySrc = readFileSync(
  new URL("../services/capabilities/capability-registry.ts", import.meta.url),
  "utf-8"
);
// Router-decomposition Wave 7 moved `synap_list_capabilities` out of
// `adapter.ts`'s switch into its own domain file.
const mcpSrc = readFileSync(
  new URL("../routers/mcp/handlers/capability.ts", import.meta.url),
  "utf-8"
);

describe("tripwire: providers are data-driven, not hardcoded", () => {
  it("providerTemplateKey falls back to the nango-<provider> convention", () => {
    // An UNKNOWN provider still yields a candidate key (never null) → the CP
    // catalog decides whether verbs exist, not a hand-maintained code map.
    expect(providerTemplateKey("fireflies")).toBe("nango-fireflies");
    expect(providerTemplateKey("notion")).toBe("nango-notion");
    // Known override still resolves to its explicit key.
    expect(providerTemplateKey("google")).toBe("nango-google");
  });

  it("materialize no longer hard-gates on a per-provider map entry", () => {
    const mat = readFileSync(
      new URL("../connectors/materialize-tools.ts", import.meta.url),
      "utf-8"
    );
    // The old `if (!templateKey) continue;` short-circuit (which skipped every
    // provider not in the map) must be gone.
    expect(mat).not.toContain("if (!templateKey) continue");
  });
});

describe("tripwire: agents can see connection state", () => {
  it("the registry populates a connection field for provider tools", () => {
    expect(registrySrc).toContain("connectedProviderToolIds");
    expect(registrySrc).toMatch(/connection:\s*\{/);
    expect(registrySrc).toContain("required: true");
  });

  it("MCP list door forwards the integration's `connection` field unfiltered", () => {
    // WAVE-7 UPDATE: the `b32b606d` router-decomposition split moved
    // `synap_list_capabilities` from a flat, hand-computed `enabled` /
    // `needsConnection` action projection (the tokens this test used to
    // assert on) to the sectioned `sections.integrations` view built by
    // `sectionCapabilities` (capability-registry.ts). That view still carries
    // the SAME signal per integration — `connection: { required, connected,
    // provider }` (asserted on `registrySrc` above) — so an agent can still
    // tell "connected" from "needs connection"; only the derived boolean
    // token is gone, not the underlying fact. Assert the door forwards that
    // section verbatim instead of stripping the field back out.
    expect(mcpSrc).toContain("integrations: sections.integrations");
  });
});
