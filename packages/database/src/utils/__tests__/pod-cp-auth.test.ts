/**
 * podCpAuthHeaders — the ONE place a pod decides how it authenticates to its
 * Control Plane (R1-b). Real key file, real ES256 signature, real enrollment
 * record on disk; only the relay-key reader's DB is stubbed.
 *
 *   enrolled            → a fresh pod-signed JWT per call, audience = the CP
 *                         issuer the enrollment recorded
 *   key but NOT enrolled → the legacy credential, unchanged (the CP does not
 *                         know the key yet; signing would 401)
 *   enrolled, key since replaced → a typed refusal, never a silent fallback
 */

import crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../index.js", () => ({ db: {} }));
vi.mock("../vault-resolver.js", () => ({ resolveVaultReferences: vi.fn() }));

import { podCpAuthHeaders } from "../pod-cp-auth.js";
import {
  _resetPodIdentityForTest,
  getPodJwks,
  getPodKeyId,
  POD_JWT_TYP,
} from "../pod-identity.js";

const dir = mkdtempSync(path.join(tmpdir(), "pod-cp-auth-"));
const ENROLL = path.join(dir, "pod-identity-enrollment.json");
const SAVED = { ...process.env };

function writeKey(name: string): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const file = path.join(dir, name);
  writeFileSync(
    file,
    privateKey.export({ format: "pem", type: "pkcs8" }) as string
  );
  return file;
}

function decode(token: string) {
  const [h, p, s] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p!, "base64url").toString()),
    verified: crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      {
        key: crypto.createPublicKey({
          key: getPodJwks().keys[0] as crypto.JsonWebKey,
          format: "jwk",
        }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(s!, "base64url")
    ),
  };
}

beforeEach(() => {
  process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey(
    `k-${crypto.randomUUID()}.pem`
  );
  process.env.SYNAP_POD_IDENTITY_ENROLLMENT_FILE = ENROLL;
  process.env.PUBLIC_URL = "https://pod.lab1.synap.test";
  process.env.CONTROL_PLANE_URL = "https://cp-transport.synap.test/";
  process.env.SYNAP_POD_INTERNAL_KEY = "test-internal-key";
  process.env.CP_RELAY_KEY = "test-relay-jwt";
  _resetPodIdentityForTest();
  rmSync(ENROLL, { force: true });
});
afterEach(() => {
  process.env = { ...SAVED };
  _resetPodIdentityForTest();
});

describe("podCpAuthHeaders", () => {
  it("a pod with a key but NO enrollment keeps its legacy credential", async () => {
    expect(
      await podCpAuthHeaders({ purpose: "projects", legacy: "internal-key" })
    ).toEqual({
      via: "internal-key",
      headers: { "X-Internal-Key": "test-internal-key" },
    });
    expect(
      await podCpAuthHeaders({ purpose: "relay", legacy: "relay-key" })
    ).toMatchObject({
      via: "relay-key",
      headers: { Authorization: "Bearer test-relay-jwt" },
    });
  });

  it("an enrolled pod signs a fresh pod JWT per call, for the recorded CP issuer and the purpose", async () => {
    writeFileSync(
      ENROLL,
      JSON.stringify({
        podId: "pod-1",
        kid: getPodKeyId(),
        issuer: "https://api.synap.test",
      })
    );
    const a = await podCpAuthHeaders({
      purpose: "invites",
      legacy: "internal-key",
    });
    const b = await podCpAuthHeaders({
      purpose: "invites",
      legacy: "internal-key",
    });
    expect(a?.via).toBe("pod-jwt");
    expect(a?.headers).not.toHaveProperty("X-Internal-Key");
    const token = a!.headers.Authorization!.replace(/^Bearer /, "");
    const { header, payload, verified } = decode(token);
    expect(verified).toBe(true);
    expect(header).toEqual({
      alg: "ES256",
      typ: POD_JWT_TYP,
      kid: getPodKeyId(),
    });
    expect(payload).toMatchObject({
      iss: "https://pod.lab1.synap.test",
      aud: "https://api.synap.test",
      purpose: "invites",
    });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(300);
    // single use on the CP ⇒ never the same token twice
    expect(b!.headers.Authorization).not.toBe(a!.headers.Authorization);
  });

  it("without a recorded issuer the audience is the CONTROL_PLANE_URL origin", async () => {
    writeFileSync(ENROLL, JSON.stringify({ podId: "pod-1" }));
    const auth = await podCpAuthHeaders({
      purpose: "relay",
      legacy: "relay-key",
    });
    expect(auth?.via).toBe("pod-jwt");
    expect(decode(auth!.bearer).payload.aud).toBe(
      "https://cp-transport.synap.test"
    );
  });

  it("an enrolled pod whose key was replaced is a typed refusal, never a legacy fallback", async () => {
    writeFileSync(ENROLL, JSON.stringify({ podId: "pod-1", kid: "other-kid" }));
    await expect(
      podCpAuthHeaders({ purpose: "projects", legacy: "internal-key" })
    ).rejects.toMatchObject({ code: "POD_KEY_NOT_ENROLLED" });
  });

  it("an unreadable enrollment record throws — it is neither enrolled nor not", async () => {
    writeFileSync(ENROLL, "{not json");
    await expect(
      podCpAuthHeaders({ purpose: "projects", legacy: "internal-key" })
    ).rejects.toMatchObject({ code: "POD_ENROLLMENT_UNREADABLE" });
  });

  it("no enrollment and no legacy credential = null (a self-hosted pod)", async () => {
    delete process.env.SYNAP_POD_INTERNAL_KEY;
    expect(
      await podCpAuthHeaders({ purpose: "projects", legacy: "internal-key" })
    ).toBeNull();
  });
});
