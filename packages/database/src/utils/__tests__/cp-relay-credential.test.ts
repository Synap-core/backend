/**
 * readCpRelayCredential — the ONE pod CP-credential reader.
 *
 * The property that matters: an absent credential (null) and a FAILED read
 * (throw) are different facts. A reader that folds a failed row or vault read
 * into null makes a DB outage look like "never provisioned".
 * The db and vault are stubbed; the selection logic is real.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  resolveVault: vi.fn(),
}));

vi.mock("../../index.js", () => ({
  db: { query: { sourceConfigs: { findMany: h.findMany } } },
}));
vi.mock("../vault-resolver.js", () => ({
  resolveVaultReferences: h.resolveVault,
}));

import {
  CpRelayVaultUnresolvedError,
  readCpRelayCredential,
  relayKeyExpiry,
} from "../cp-relay-credential.js";

function jwtWithExp(expSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ exp: expSeconds })).toString(
    "base64url"
  );
  return `h.${body}.s`;
}

beforeEach(() => {
  delete process.env.CP_RELAY_KEY;
  delete process.env.SOURCE_RELAY_KEY;
  h.findMany.mockReset();
  h.resolveVault.mockReset();
});

describe("readCpRelayCredential", () => {
  it("the env key wins without touching the database", async () => {
    process.env.CP_RELAY_KEY = jwtWithExp(2_000_000_000);
    const cred = await readCpRelayCredential();
    expect(cred?.key).toBe(process.env.CP_RELAY_KEY);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("no seeded rows → null (absent, not failed)", async () => {
    h.findMany.mockResolvedValue([]);
    expect(await readCpRelayCredential()).toBeNull();
  });

  it("picks the longest-lived key among seeded rows", async () => {
    const short = jwtWithExp(1_900_000_000);
    const long = jwtWithExp(2_100_000_000);
    h.findMany.mockResolvedValue([
      { config: { relayKey: "vault:a" }, userId: "u" },
      { config: { relayKey: "vault:b" }, userId: "u" },
    ]);
    h.resolveVault
      .mockResolvedValueOnce({ relayKey: short })
      .mockResolvedValueOnce({ relayKey: long });
    const cred = await readCpRelayCredential();
    expect(cred?.key).toBe(long);
    expect(cred?.expiresAt).toEqual(relayKeyExpiry(long));
  });

  it("a FAILED row read THROWS — never folded into null", async () => {
    h.findMany.mockRejectedValue(new Error("db down"));
    await expect(readCpRelayCredential()).rejects.toThrow("db down");
  });

  it("reads through INJECTED handles, never this package's own (the seam callers' tests swap)", async () => {
    const key = jwtWithExp(2_100_000_000);
    const findMany = vi.fn(async () => [
      { config: { relayKey: "vault:x" }, userId: "u" },
    ]);
    const resolveVault = vi.fn(async () => ({ relayKey: key }));
    const cred = await readCpRelayCredential({
      database: { query: { sourceConfigs: { findMany } } } as never,
      resolveVault,
    });
    expect(cred?.key).toBe(key);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(resolveVault).toHaveBeenCalledWith({ relayKey: "vault:x" }, "u");
    expect(h.findMany).not.toHaveBeenCalled();
    expect(h.resolveVault).not.toHaveBeenCalled();
  });

  it("a seeded row whose vault ref resolves to '' THROWS vault-unresolved — a broken vault is not 'no credential'", async () => {
    h.findMany.mockResolvedValue([
      { config: { relayKey: "vault:a" }, userId: "u" },
      { config: { relayKey: "vault:b" }, userId: "u" },
    ]);
    h.resolveVault.mockResolvedValue({ relayKey: "" });
    const err = await readCpRelayCredential().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CpRelayVaultUnresolvedError);
    expect((err as CpRelayVaultUnresolvedError).code).toBe("vault-unresolved");
    expect((err as Error).message).toBe(
      "relay row present, vault reference unresolved"
    );
    expect((err as CpRelayVaultUnresolvedError).unresolvedRows).toBe(2);
  });

  it("stays lenient when ANY seeded row resolves (a stale broken row next to a live key)", async () => {
    const live = jwtWithExp(2_100_000_000);
    h.findMany.mockResolvedValue([
      { config: { relayKey: "vault:stale" }, userId: "u" },
      { config: { relayKey: "vault:live" }, userId: "u" },
    ]);
    h.resolveVault
      .mockResolvedValueOnce({ relayKey: "" })
      .mockResolvedValueOnce({ relayKey: live });
    expect((await readCpRelayCredential())?.key).toBe(live);
  });

  it("a FAILED vault read THROWS — never folded into null", async () => {
    h.findMany.mockResolvedValue([
      { config: { relayKey: "vault:a" }, userId: "u" },
    ]);
    h.resolveVault.mockRejectedValue(new Error("vault sealed"));
    await expect(readCpRelayCredential()).rejects.toThrow("vault sealed");
  });
});
