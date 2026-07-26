import { describe, it, expect } from "vitest";
import {
  CLIENT_SAFE_WORKSPACE_SETTINGS_KEYS,
  projectWorkspaceSettings,
} from "@synap/database";
import { readFileSync } from "fs";

/**
 * Behavioural proof that the shared settings projection drops every known
 * credential and every client-facing router door uses that one projection.
 */
const src = readFileSync(
  new URL("../routers/workspaces.ts", import.meta.url),
  "utf-8"
);

describe("tripwire: workspace settings projection never ships a credential", () => {
  const allow: readonly string[] = CLIENT_SAFE_WORKSPACE_SETTINGS_KEYS;

  const SECRETS = [
    "nango",
    "messaging",
    "enrichment",
    "controlPlane",
    "mcpServers",
  ];

  it("allowlist exists and is non-trivial", () => {
    expect(allow.length).toBeGreaterThan(5);
  });

  it("NO credential container is allowlisted", () => {
    const leaked = SECRETS.filter((k) => allow.includes(k));
    expect(leaked).toEqual([]);
  });

  it("devplane is leaf-restricted (raw-SQL writes an undeclared userProviders subtree)", () => {
    expect(
      projectWorkspaceSettings({
        settings: {
          devplane: {
            localTerminalEnabled: true,
            userProviders: { user_1: { openai: { apiKey: "secret" } } },
          },
        },
      }).settings
    ).toEqual({ devplane: { localTerminalEnabled: true } });
  });

  it("every client-facing return is projected (no raw spread outside admin)", () => {
    const spreads = [...src.matchAll(/\.\.\.workspace\b/g)].length;
    // helper's own return + adminGet (podAdminProcedure, deliberate)
    expect(spreads).toBeLessThanOrEqual(2);
  });

  it("projects the generic workspace update audit payload", () => {
    expect(src).toMatch(
      /phase:\s*"completed"[\s\S]{0,500}settings:\s*input\.settings\s*\?\s*projectWorkspaceSettings\(\{\s*settings:\s*input\.settings\s*\}\)\.settings/
    );
  });
});
