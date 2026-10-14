/**
 * Inbound sync auth (`authenticateReceivePeer` / `authenticatePullPeer`) over
 * ENCRYPTED peer tokens. `sync_peers.auth_token` goes through the field-crypto
 * door, so a peer can no longer be found by an SQL equality on the cell: the
 * candidates are loaded and each token is opened and compared in the process.
 *
 * Drives the REAL auth functions with the REAL field-crypto door (keys
 * generated per run, set as SYNAP_FIELD_KEYS); only `db.query.syncPeers` and
 * the logger are faked.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    workspaceIds: string[] | null;
    authToken: string | null;
  }>,
  warn: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      ...((actual as { db?: object }).db ?? {}),
      query: { syncPeers: { findMany: vi.fn(async () => m.rows) } },
    },
  };
});
vi.mock("@synap-core/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap-core/core")>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: m.warn,
    child: () => ({ info: vi.fn(), warn: m.warn, error: vi.fn() }),
  }),
}));
vi.mock("./sync-management.js", () => ({ upsertSyncPeer: vi.fn() }));
vi.mock("../utils/sync-realtime-hook.js", () => ({
  invalidateSyncPeerCache: vi.fn(),
}));

import { sealSyncPeerToken } from "@synap/database";
import { authenticatePullPeer, authenticateReceivePeer } from "./sync.js";

const saved = {
  SYNAP_FIELD_KEYS: process.env.SYNAP_FIELD_KEYS,
  SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT:
    process.env.SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT,
};
process.env.SYNAP_FIELD_KEYS = `t1:${randomBytes(32).toString("base64")}`;
delete process.env.SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT;

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const TOKEN_A = `test-token-a-${randomUUID()}`;
const TOKEN_B = `test-token-b-${randomUUID()}`;

const bearer = (t: string) => `Bearer ${t}`;

describe.each([
  ["authenticateReceivePeer", authenticateReceivePeer],
  ["authenticatePullPeer", authenticatePullPeer],
] as const)("%s over field-encrypted tokens", (_name, authenticate) => {
  beforeEach(() => {
    m.warn.mockClear();
    m.rows = [
      {
        id: A,
        workspaceIds: ["ws-a"],
        authToken: sealSyncPeerToken(TOKEN_A, A),
      },
      {
        id: B,
        workspaceIds: ["ws-b"],
        authToken: sealSyncPeerToken(TOKEN_B, B),
      },
    ];
  });

  it("stores envelopes, not tokens (the fixture is what a keyed pod holds)", () => {
    expect(m.rows[0]!.authToken!.startsWith("senc:1:t1:")).toBe(true);
    expect(m.rows[0]!.authToken).not.toContain(TOKEN_A);
  });

  it("(a) a sealed token authenticates the right peer among several", async () => {
    expect(await authenticate(bearer(TOKEN_B))).toEqual({
      peerId: B,
      workspaceIds: ["ws-b"],
    });
    expect(await authenticate(bearer(TOKEN_A))).toEqual({
      peerId: A,
      workspaceIds: ["ws-a"],
    });
  });

  it("(b) a wrong token, or a ciphertext presented as the token, is refused", async () => {
    expect(await authenticate(bearer(`test-token-wrong-${randomUUID()}`))).toBe(
      null
    );
    expect(await authenticate(bearer(m.rows[0]!.authToken!))).toBe(null);
    expect(await authenticate(null)).toBe(null);
  });

  it("(c) an envelope copied from another peer row cannot authenticate — logged, not thrown", async () => {
    // C holds A's envelope: bound to A's id, it does not open as C.
    m.rows = [{ id: C, workspaceIds: null, authToken: m.rows[0]!.authToken }];
    await expect(authenticate(bearer(TOKEN_A))).resolves.toBe(null);
    expect(m.warn).toHaveBeenCalledWith(
      { peerId: C, code: "DECRYPT_FAILED" },
      expect.stringContaining("could not be decrypted")
    );
    // The token itself never reaches the log.
    expect(JSON.stringify(m.warn.mock.calls)).not.toContain(TOKEN_A);
  });

  it("(c') a broken row does not stop the next peer from authenticating", async () => {
    m.rows = [
      { id: C, workspaceIds: null, authToken: m.rows[0]!.authToken },
      ...m.rows,
    ];
    expect(await authenticate(bearer(TOKEN_B))).toEqual({
      peerId: B,
      workspaceIds: ["ws-b"],
    });
  });

  it("(d) a plaintext legacy row still matches while the flag is on", async () => {
    m.rows = [
      ...m.rows,
      { id: C, workspaceIds: null, authToken: "legacy-plain-token" },
    ];
    expect(await authenticate(bearer("legacy-plain-token"))).toEqual({
      peerId: C,
      workspaceIds: null,
    });
  });

  it("(d') …and is refused once SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT=false", async () => {
    m.rows = [{ id: C, workspaceIds: null, authToken: "legacy-plain-token" }];
    process.env.SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT = "false";
    try {
      expect(await authenticate(bearer("legacy-plain-token"))).toBe(null);
      expect(m.warn).toHaveBeenCalledWith(
        { peerId: C, code: "NOT_AN_ENVELOPE" },
        expect.any(String)
      );
    } finally {
      delete process.env.SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT;
    }
  });
});
