/**
 * `/setup/service` — no privilege escalation by minting.
 *
 * THE HOLE THIS CLOSES. Narrowing `POST /ai-providers` to a dedicated
 * `providers.write` scope is worthless on its own, because `/setup/service`
 * accepts ANY active `hub-protocol.write` key (auth Path 4 — the scope every
 * agent key is minted with) and then mints a key with CALLER-DECLARED scopes,
 * validated only for spelling. An agent could therefore mint itself a
 * `providers.write` key and repoint the pod's LLM traffic anyway. The narrow
 * scope and this check are ONE mechanism; neither works alone.
 *
 * WHAT THESE ACTUALLY TEST — stated precisely, because the first draft of this
 * file overclaimed and the overclaim is the exact defect this repo keeps
 * hitting. They do NOT drive the route: `/setup/service`'s auth helper reaches
 * the database before the branch under test, so standing it up here would test
 * postgres, not the rule. Instead:
 *
 *  1. The SHARED PREDICATE and its scope list are tested for real — the handler
 *     calls `isPrivilegedMintScope`, so these are the same code path.
 *  2. A SOURCE TRIPWIRE asserts the handler still gates on `api_key_surface`
 *     using that predicate, so the decision cannot quietly leave the door while
 *     the predicate tests stay green. This is the honest replacement for a
 *     mirrored `decide()` helper, which would have proved only that two copies
 *     of a rule agree — sameness, never correctness.
 *
 * NEGATIVE CONTROLS RUN (mutation applied, grep-verified as landed, reverted):
 *  - the `if (auth.authMethod === "api_key_surface")` block deleted from
 *    setup.ts → the source tripwire fails (the predicate tests do NOT, which is
 *    precisely why the tripwire has to exist).
 *  - `PRIVILEGED_MINT_SCOPES` emptied → 3 fail, AND the file's test count drops
 *    from 14 to 11, because `it.each` over an empty array generates no cases at
 *    all. That is the vacuous-scan failure mode in miniature: the per-scope
 *    assertions do not go red, they simply cease to exist. The explicit
 *    "is not empty" assertion is the only thing that catches it — which is why
 *    a scan without a non-vacuity floor proves nothing.
 *
 * NOT COVERED, measured: that `providers.write` is genuinely unreachable by
 * every other mint path. This pins `/setup/service`, the door whose auth
 * explicitly admits a surface key. `/setup/agent` mints from a fixed bundle
 * (`SETUP_AGENT_HUB_SCOPES`) and takes no caller scopes, so it cannot express
 * this request at all — asserted below so that stops being an assumption.
 */

import { describe, expect, it } from "vitest";

import { SETUP_AGENT_HUB_SCOPES } from "../../../services/hub-integration-registration.js";
import { PRIVILEGED_MINT_SCOPES } from "@synap/database/schema";

describe("PRIVILEGED_MINT_SCOPES", () => {
  it("names providers.write — the scope the ai-providers door was narrowed to", () => {
    expect(PRIVILEGED_MINT_SCOPES).toContain("providers.write");
  });

  it("names setup.agent, the escalation multiplier", () => {
    // A key that can mint agents can mint one holding anything else.
    expect(PRIVILEGED_MINT_SCOPES).toContain("setup.agent");
  });

  it("is not empty — an empty list would silently protect nothing", () => {
    expect(PRIVILEGED_MINT_SCOPES.length).toBeGreaterThan(0);
  });
});

describe("the agent bundle cannot express a privileged scope", () => {
  it("SETUP_AGENT_HUB_SCOPES holds none of them", () => {
    // `/setup/agent` mints from this fixed bundle and accepts no caller scopes,
    // so it is not a second way in. Asserted rather than assumed.
    const overlap = (SETUP_AGENT_HUB_SCOPES as readonly string[]).filter((s) =>
      (PRIVILEGED_MINT_SCOPES as readonly string[]).includes(s)
    );
    expect(overlap).toEqual([]);
  });

  it("the default agent bundle still carries ordinary write access", () => {
    // Non-vacuity: the assertion above must not pass merely because the bundle
    // is empty or renamed out from under this test.
    expect(SETUP_AGENT_HUB_SCOPES).toContain("hub-protocol.write");
  });
});

describe("the shared predicate", () => {
  it.each(PRIVILEGED_MINT_SCOPES as readonly string[])(
    "classifies %s as privileged",
    async (scope) => {
      const { isPrivilegedMintScope } = await import("@synap/database/schema");
      expect(isPrivilegedMintScope(scope)).toBe(true);
    }
  );

  it.each([
    "hub-protocol.read",
    "hub-protocol.write",
    "mcp.read",
    "chat.stream",
  ])("leaves the ordinary scope %s alone", async (scope) => {
    const { isPrivilegedMintScope } = await import("@synap/database/schema");
    expect(isPrivilegedMintScope(scope)).toBe(false);
  });
});

describe("source tripwire — the handler still applies the rule", () => {
  /**
   * Reads `setup.ts` and pins that the `/setup/service` handler gates the
   * surface-key branch on the shared predicate.
   *
   * A regex over source is a weak instrument and this says so: it proves the
   * CHECK IS PRESENT, not that it runs before the mint, and not that a future
   * fourth auth method is covered. It exists because the predicate tests alone
   * would stay green if the call site were deleted — which is the failure mode
   * that actually reopens the escalation.
   */
  it("gates api_key_surface on isPrivilegedMintScope", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("./setup.ts", import.meta.url).pathname,
      "utf-8"
    );

    // Non-vacuity: we are reading the file we think we are.
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain('app.post("/setup/service"');

    // Comments stripped first — a `/* ... */` block naming the identifiers
    // would otherwise satisfy this scan without any code doing the work. That
    // exact trick has certified an empty implementation in this repo before.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(code).toContain('auth.authMethod === "api_key_surface"');
    expect(code).toContain("isPrivilegedMintScope");

    // And the two must appear in the SAME region, not merely both somewhere.
    const guardAt = code.indexOf('auth.authMethod === "api_key_surface"');
    const predicateAt = code.indexOf("isPrivilegedMintScope", guardAt);
    expect(predicateAt).toBeGreaterThan(-1);
    expect(predicateAt - guardAt).toBeLessThan(600);
  });
});

describe("the legitimate provisioning path stays open", () => {
  it("providers.write is a REAL scope, so an operator credential can grant it", async () => {
    // The point of the fix is to narrow WHO may grant it, not to make it
    // ungrantable — `eve` still needs it. If this scope ever left
    // API_KEY_SCOPES, minting would 400 and the CLI would be unprovisionable.
    const { isValidScope } = await import("@synap/database/schema");
    expect(isValidScope("providers.write")).toBe(true);
  });
});
