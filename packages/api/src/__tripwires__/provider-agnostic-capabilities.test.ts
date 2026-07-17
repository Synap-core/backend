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
const mcpSrc = readFileSync(
  new URL("../routers/mcp/adapter.ts", import.meta.url),
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

  it("MCP runnable projection gates enabled on the connection, not just governance", () => {
    expect(mcpSrc).toContain("needsConnection");
    // enabled must AND-in the connection gate — a disconnected provider verb is
    // not runnable even when governance is auto.
    expect(mcpSrc).toContain('cap.governance === "auto" && !needsConnection');
  });
});
