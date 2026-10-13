/**
 * /api/sync/setup-peer — SECURITY-KEYS-2026-10-13 C3.
 *
 * Before the fix the route verified the CP `sync-setup` JWT with the bare
 * verifier and NO audience (and, without CONTROL_PLANE_URL, against whatever
 * issuer the token named), then took `peerUrl` from the unsigned body. A token
 * minted for pod A could be replayed at pod B within its 5 minutes to add a
 * push peer at an attacker URL — streaming B's events out.
 *
 * Drives the SEAM: the REAL `jwks-client` door behind the REAL Hono app; only
 * the JWKS network, the registry row, the receipt store and the peer upsert are
 * faked.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CP = "https://api.cp.example.test";
const POD = "https://pod-a.example.test";
const PEER = "https://pod-b.example.test";

const m = vi.hoisted(() => ({
  getByUrl: vi.fn(),
  consumeReceipt: vi.fn(),
  httpsRequest: vi.fn(),
  resolve: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  TrustedIssuerService: class {
    getByUrl = m.getByUrl;
  },
  consumeFederatedAssertionReceipt: m.consumeReceipt,
}));
vi.mock("node:https", () => ({ request: m.httpsRequest }));
vi.mock("../utils/issuer-url-safety.js", () => ({
  normalizeIssuerUrl: (value: string) => {
    try {
      const u = new URL(value);
      if (u.protocol !== "https:") return null;
      return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      return null;
    }
  },
  resolvePublicIssuerEndpoint: m.resolve,
}));
vi.mock("./sync-management.js", () => ({ upsertSyncPeer: m.upsert }));
vi.mock("../utils/sync-realtime-hook.js", () => ({
  invalidateSyncPeerCache: vi.fn(),
}));

import { syncReceiveApp } from "./sync.js";
import { clearJwksCache } from "../utils/jwks-client.js";

const CP_ENTRY = {
  id: "00000000-0000-4000-8000-00000000c0de",
  issuerUrl: CP,
  status: "approved",
  allowedScopes: [
    "auth:exchange-user",
    "identity:link-user",
    "membership:grant",
    "source-config:write",
  ],
};

let keys: ReturnType<typeof crypto.generateKeyPairSync>;

function serveJwks() {
  const jwk = {
    ...keys.publicKey.export({ format: "jwk" }),
    kid: "cp-key",
    alg: "ES256",
  };
  m.httpsRequest.mockImplementation(((
    _o: unknown,
    cb: (r: unknown) => void
  ) => {
    let onData: ((c: Buffer) => void) | undefined;
    const res = {
      statusCode: 200,
      destroy: vi.fn(),
      resume: vi.fn(),
      on: vi.fn((e: string, l: (c: Buffer) => void) => {
        if (e === "data") onData = l;
        return res;
      }),
      once: vi.fn((e: string, l: () => void) => {
        if (e === "end") {
          queueMicrotask(() => {
            onData?.(Buffer.from(JSON.stringify({ keys: [jwk] })));
            l();
          });
        }
        return res;
      }),
    };
    cb(res);
    return { destroy: vi.fn(), end: vi.fn(), once: vi.fn() };
  }) as never);
}

/** The `sync-setup` token as the FIXED CP signs it (`aud` + `peerUrl`). */
function token(over: Record<string, unknown> = {}) {
  return jwt.sign(
    {
      iss: CP,
      jti: crypto.randomUUID(),
      type: "sync-setup",
      podId: "pod-a",
      action: "add",
      aud: POD,
      peerUrl: PEER,
      ...over,
    },
    keys.privateKey,
    { algorithm: "ES256", expiresIn: "5m", keyid: "cp-key" }
  );
}

async function addPeer(jwtToken: string, peerUrl = PEER) {
  return syncReceiveApp.request("/setup-peer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwtToken}`,
    },
    body: JSON.stringify({
      peerUrl,
      direction: "push",
      authToken: "test-secret-sync-token",
    }),
  });
}

const originalPublicUrl = process.env.PUBLIC_URL;

describe("POST/DELETE /setup-peer — one issuer door + target binding (C3)", () => {
  beforeEach(() => {
    process.env.PUBLIC_URL = POD;
    clearJwksCache();
    keys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    m.httpsRequest.mockReset();
    serveJwks();
    m.getByUrl
      .mockReset()
      .mockImplementation(async (url: string) =>
        url === CP ? CP_ENTRY : null
      );
    m.consumeReceipt.mockReset().mockResolvedValue("consumed");
    m.upsert.mockReset().mockResolvedValue("peer-1");
    m.resolve.mockReset().mockImplementation(async (issuerUrl: string) => {
      const host = new URL(issuerUrl).hostname;
      return {
        issuerUrl,
        hostname: host,
        hostHeader: host,
        address: "93.184.216.34",
        family: 4,
        port: 443,
        jwksPath: "/.well-known/jwks.json",
      };
    });
  });
  afterEach(() => {
    if (originalPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = originalPublicUrl;
  });

  it("adds the SIGNED peer for a token minted for this pod", async () => {
    const res = await addPeer(token());
    expect(res.status).toBe(200);
    expect(m.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ peerPodUrl: PEER, direction: "push" })
    );
  });

  it("refuses a token minted for ANOTHER pod (cross-pod replay)", async () => {
    const res = await addPeer(token({ aud: "https://pod-c.example.test" }));
    expect(res.status).toBe(401);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("refuses the pre-fix token shape (no aud, no peerUrl)", async () => {
    const res = await addPeer(token({ aud: undefined, peerUrl: undefined }));
    expect(res.status).toBe(401);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("refuses a body peerUrl that is not the signed one (attacker URL)", async () => {
    const res = await addPeer(token(), "https://attacker.example.test");
    expect(res.status).toBe(401);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("refuses a token from an issuer this pod never approved (self-hosted, no CP)", async () => {
    m.getByUrl.mockResolvedValue(null);
    const res = await addPeer(token());
    expect(res.status).toBe(401);
    expect(m.httpsRequest).not.toHaveBeenCalled();
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("refuses a `remove` token used to add, and another CP purpose", async () => {
    expect((await addPeer(token({ action: "remove" }))).status).toBe(401);
    expect(
      (await addPeer(token({ type: "entity-share-deliver" }))).status
    ).toBe(401);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("refuses a DELETE whose body peerUrl is not the signed one", async () => {
    const res = await syncReceiveApp.request("/setup-peer", {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token({ action: "remove" })}`,
      },
      body: JSON.stringify({ peerUrl: "https://other.example.test" }),
    });
    expect(res.status).toBe(401);
  });

  it("fails closed when the pod does not know its own URL", async () => {
    delete process.env.PUBLIC_URL;
    expect((await addPeer(token())).status).toBe(401);
    expect(m.upsert).not.toHaveBeenCalled();
  });
});
