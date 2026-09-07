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
    // PINNED, not a ceiling. This guard exists to stop a raw spread leaking a
    // credential container out of a projected door, and it was written as
    // `<= 2` back when TWO sites spread (the helper's own return + adminGet).
    // The helper stopped spreading; the ceiling did not move, so a whole extra
    // spread — one brand-new leak — landed GREEN. A ceiling above the actual
    // count is pre-authorised slack for the exact defect being guarded.
    // Today the ONE remaining site is adminGet (podAdminProcedure, deliberate,
    // documented at its call site). If you legitimately remove it, LOWER this
    // number; never raise it to make a new spread pass.
    expect(spreads).toBe(1);
  });

  it("the guard has a corpus to guard (the source is read and still spreads)", () => {
    // Tightness: the count above is only meaningful if it was measured against
    // the real router. If workspaces.ts is renamed/moved, readFileSync would
    // throw — but if the doors are RESTRUCTURED so the pattern stops occurring,
    // the count silently becomes 0 and `toBe(1)` fails loudly rather than a
    // ceiling passing on an empty corpus. Assert the corpus explicitly so the
    // failure names the cause.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toMatch(/podAdminProcedure/);
    expect(src).toMatch(/projectWorkspaceSettings/);
  });

  it("the one sanctioned spread is the pod-admin door, not a user-facing one", () => {
    // A bare count cannot tell WHICH site spreads: retiring adminGet while a
    // user-facing door gained a spread keeps the count at 1 and the guard green,
    // even though the leak is now reachable by a non-admin. Pin the identity,
    // not just the arity — the spread must sit inside a podAdminProcedure body.
    const idx = src.indexOf("...workspace");
    expect(idx).toBeGreaterThan(-1);
    const before = src.slice(0, idx);
    const enclosingProcedure = before.lastIndexOf("Procedure");
    const enclosingDoor = before.slice(
      Math.max(0, enclosingProcedure - 40),
      enclosingProcedure + "Procedure".length
    );
    expect(
      enclosingDoor,
      `The surviving \`...workspace\` spread is no longer under a podAdminProcedure — a raw workspace row (settings included) may now reach a non-admin caller. Project it through projectWorkspaceSettings.`
    ).toMatch(/podAdminProcedure/);
  });

  it("projects the generic workspace update audit payload", () => {
    expect(src).toMatch(
      /phase:\s*"completed"[\s\S]{0,500}settings:\s*input\.settings\s*\?\s*projectWorkspaceSettings\(\{\s*settings:\s*input\.settings\s*\}\)\.settings/
    );
  });
});
