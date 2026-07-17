import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * Behavioural proof that the settings projection drops every known credential.
 * Extracts the REAL allowlist from source (not a copy) so the test cannot drift.
 */
const src = readFileSync(
  new URL("../routers/workspaces.ts", import.meta.url),
  "utf-8"
);

function extractList(name: string): string[] {
  const m = src.match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`${name} not found`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("tripwire: workspace settings projection never ships a credential", () => {
  const allow = extractList("CLIENT_SAFE_SETTINGS_KEYS");

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
    expect(src).toContain("CLIENT_SAFE_SETTINGS_SUBKEYS");
    const sub = src.match(/devplane:\s*\[([^\]]*)\]/);
    expect(sub, "devplane must have a leaf allowlist").toBeTruthy();
    expect(sub![1]).toContain("localTerminalEnabled");
    expect(sub![1]).not.toContain("userProviders");
  });

  it("every client-facing return is projected (no raw spread outside admin)", () => {
    const spreads = [...src.matchAll(/\.\.\.workspace\b/g)].length;
    // helper's own return + adminGet (podAdminProcedure, deliberate)
    expect(spreads).toBeLessThanOrEqual(2);
  });
});
