import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../lib/trpc", () => ({ trpc: {} }));
import { GRANT_PRESETS } from "@synap-core/types/grants";
import { keyMintFromRole } from "./grant-role-picker";
import { KEY_EXPIRY_OPTIONS, offeredKeyScopes } from "./key-scopes";

/**
 * The scopes `apiKeys.availableScopes` serves (backend `API_KEY_SCOPES`, the
 * source of truth) — the subset this dialog curates from.
 */
const BACKEND = [
  "hub-protocol.read",
  "hub-protocol.write",
  "hub-protocol.admin",
  "data.read",
  "data.write",
  "mcp.read",
  "mcp.write",
  "setup.agent",
  "chat.stream",
  "realtime:observe",
];

describe("the Personal key dialog can mint a key that connects an app", () => {
  // The owner minted a Personal key here and `synap app connect` answered
  // "Missing scope: hub-protocol.write": only the System type offered it.
  it("offers hub-protocol.write on a Personal key", () => {
    expect(offeredKeyScopes("personal", BACKEND)).toContain(
      "hub-protocol.write"
    );
  });

  it("with the Full access role, it is an unbounded `*` (what app connect needs)", () => {
    const full = GRANT_PRESETS.find((r) => r.id === "full-access")!;
    expect(
      keyMintFromRole(full.id, GRANT_PRESETS, { expiresInDays: 1 })
    ).toMatchObject({ grant: { permissions: ["*"] }, expiresInDays: 1 });
  });

  it("the backend list still decides: a scope it does not serve is never offered", () => {
    const withoutWrite = BACKEND.filter((s) => s !== "hub-protocol.write");
    expect(offeredKeyScopes("personal", withoutWrite)).not.toContain(
      "hub-protocol.write"
    );
  });

  it("offers a 1-day lifetime (a key made for one job)", () => {
    const keys = KEY_EXPIRY_OPTIONS.map((o) => o.key);
    expect(keys).toContain("1");
    // Every numeric option is a whole number of days ≥ 1 (the mint door's floor).
    for (const k of keys.filter((k) => k !== "never"))
      expect(Number.isInteger(Number(k)) && Number(k) >= 1).toBe(true);
  });
});
