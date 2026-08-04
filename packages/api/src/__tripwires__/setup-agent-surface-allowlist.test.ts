/**
 * Tripwire: /setup/agent surface-key path allowlist + human PAT named agents.
 *
 * - SURFACE_AGENT_TYPES always allowed on api_key_surface.
 * - Non-surface agentType (twin, custom slug, assistant, …) only when the
 *   authenticating key is human-owned (linkedUserId null).
 * - Agent keys (linkedUserId set) cannot mint non-surface types.
 *
 * Structural source test — no HTTP / DB.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SETUP = "src/routers/hub-protocol/rest/setup.ts";

describe("tripwire: setup/agent surface allowlist + human named-agent create", () => {
  const src = readFileSync(join(process.cwd(), SETUP), "utf8");

  it("tracks whether the surface key is human-owned (linkedUserId null)", () => {
    expect(src).toMatch(/surfaceKeyIsHumanOwned/);
    expect(src).toMatch(
      /linkedUserId\s*==\s*null\s*\|\|\s*keyRecord\.linkedUserId\s*===\s*""/
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
