/**
 * Tripwire: /setup/agent surface-key path allowlist + human PAT named agents.
 *
 * - SURFACE_AGENT_TYPES always allowed on api_key_surface.
 * - Non-surface agentType (twin, custom slug, assistant, …) only when the
 *   authenticating key is human-owned (key PRINCIPAL is not an agent).
 * - Agent keys — linked OR pod-wide (no `linkedUserId`) — cannot mint
 *   non-surface types.
 *
 * Structural source test — no HTTP / DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SETUP = "src/routers/hub-protocol/rest/setup.ts";

describe("tripwire: setup/agent surface allowlist + human named-agent create", () => {
  const src = readFileSync(join(process.cwd(), SETUP), "utf8");

  it("derives human-owned from the key PRINCIPAL (resolveKeyIdentity), not linkedUserId", () => {
    expect(src).toMatch(/surfaceKeyIsHumanOwned/);
    expect(src).toMatch(/resolveKeyIdentity\(keyRecord\)/);
    expect(src).toMatch(/surfaceKeyIsHumanOwned\s*=\s*!identity\.isAgent/);
    // Must NOT regress to the `linkedUserId==null` conflation — that
    // misclassifies a pod-wide agent key (isAgent, no linkedUserId) as
    // human-owned, letting it mint arbitrary named agents.
    expect(src).not.toMatch(
      /surfaceKeyIsHumanOwned\s*=\s*\n?\s*keyRecord\.linkedUserId\s*==\s*null/
    );
  });

  it("rejects non-surface agentType for agent keys with SURFACE_AGENT_TYPE_REQUIRED", () => {
    expect(src).toMatch(/SURFACE_AGENT_TYPE_REQUIRED/);
    expect(src).toMatch(/!isSurfaceType\s*&&\s*!surfaceKeyIsHumanOwned/);
  });

  it("still defines SURFACE_AGENT_TYPES for CLI surface installs", () => {
    expect(src).toMatch(/const SURFACE_AGENT_TYPES\s*=/);
    expect(src).toMatch(/"claude-code"/);
  });

  it("attributes createdByUserId from resolved human (creator×type, not pod-wide)", () => {
    expect(src).toMatch(/createdByUserId:\s*agentCreatorId/);
    expect(src).toMatch(/resolvedLinkedUserId\s*\?\?\s*ownerUserId/);
    expect(src).toMatch(/createdByUserId × agentType|creator × agentType/);
  });
});
