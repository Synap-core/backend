/**
 * The pod identity door (utils/pod-identity.ts) through its real surface: a
 * real P-256 key file on disk, a real ES256 signature, the real JWKS route.
 * The verification here mirrors what the CP's `verifyPodJwt` enforces, so a
 * token this door mints is one the CP can accept (the CP side has its own
 * behavioural suite in synap-control-plane-api `lib/pod-jwt.test.ts`).
 */

import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPodIdentityForTest,
  ecJwkThumbprint,
  getPodJwks,
  getPodKeyId,
  PodIdentityError,
  POD_JWT_TYP,
  signPodJwt,
} from "../pod-identity.js";
import {
  podIdentityJwksApp,
  POD_JWKS_PATH,
} from "../../routers/pod-identity-jwks.js";

const CP = "https://api.synap.test";
const dir = mkdtempSync(path.join(tmpdir(), "pod-identity-"));

function writeKey(name: string, curve = "prime256v1"): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: curve,
  });
  const file = path.join(dir, name);
  writeFileSync(
    file,
    privateKey.export({ format: "pem", type: "pkcs8" }) as string,
    { mode: 0o600 }
  );
  return file;
}

const saved = {
  file: process.env.SYNAP_POD_IDENTITY_KEY_FILE,
  url: process.env.PUBLIC_URL,
};

beforeEach(() => {
  process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey(
    `k-${crypto.randomUUID()}.pem`
  );
  process.env.PUBLIC_URL = "https://pod.lab1.synap.test/";
  _resetPodIdentityForTest();
});
afterEach(() => {
  if (saved.file === undefined) delete process.env.SYNAP_POD_IDENTITY_KEY_FILE;
  else process.env.SYNAP_POD_IDENTITY_KEY_FILE = saved.file;
  if (saved.url === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = saved.url;
  _resetPodIdentityForTest();
});

function publicKey() {
  return crypto.createPublicKey({
    key: getPodJwks().keys[0] as crypto.JsonWebKey,
    format: "jwk",
  });
}

describe("signPodJwt", () => {
  it("mints an ES256 pod+jwt for one audience + purpose that verifies against the published key", () => {
    const token = signPodJwt(
      { audience: `${CP}/`, purpose: "relay" },
      { note: "x" },
      120
    );
    const decoded = jwt.decode(token, { complete: true })!;
    expect(decoded.header).toMatchObject({
      alg: "ES256",
      typ: POD_JWT_TYP,
      kid: getPodKeyId(),
    });
    const claims = jwt.verify(token, publicKey(), {
      algorithms: ["ES256"],
      audience: CP,
      issuer: "https://pod.lab1.synap.test",
    }) as jwt.JwtPayload;
    expect(claims).toMatchObject({ purpose: "relay", note: "x", aud: CP });
    expect(claims.exp! - claims.iat!).toBe(120);
    expect(typeof claims.jti).toBe("string");
    // Every token carries a fresh jti (the CP consumes it once).
    const again = jwt.decode(
      signPodJwt({ audience: CP, purpose: "relay" }, {})
    ) as jwt.JwtPayload;
    expect(again.jti).not.toBe(claims.jti);
  });

  it("kid is the RFC 7638 thumbprint of the public key", () => {
    const jwk = getPodJwks().keys[0]!;
    const manual = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
      )
      .digest("base64url");
    expect(getPodKeyId()).toBe(manual);
    expect(ecJwkThumbprint(jwk)).toBe(manual);
    expect(jwk).not.toHaveProperty("d");
  });

  it("refuses a lifetime above 300 s, a missing purpose, a non-origin audience, and caller-set reserved claims", () => {
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err instanceof PodIdentityError ? err.code : String(err);
      }
      return "signed";
    };
    expect(
      refused(() => signPodJwt({ audience: CP, purpose: "relay" }, {}, 301))
    ).toBe("POD_JWT_BAD_REQUEST");
    expect(refused(() => signPodJwt({ audience: CP, purpose: "" }, {}))).toBe(
      "POD_JWT_BAD_REQUEST"
    );
    expect(
      refused(() =>
        signPodJwt({ audience: `${CP}/internal`, purpose: "relay" }, {})
      )
    ).toBe("POD_JWT_BAD_REQUEST");
    for (const claim of ["iss", "aud", "purpose", "exp", "iat", "jti"]) {
      expect(
        refused(() =>
          signPodJwt({ audience: CP, purpose: "relay" }, { [claim]: "forged" })
        )
      ).toBe("POD_JWT_BAD_REQUEST");
    }
    expect(
      refused(() => signPodJwt({ audience: CP, purpose: "relay" }, {}, 300))
    ).toBe("signed");
  });

  it("a missing key, a non-P-256 key and an unset PUBLIC_URL are typed refusals, never a token", () => {
    process.env.SYNAP_POD_IDENTITY_KEY_FILE = path.join(dir, "absent.pem");
    _resetPodIdentityForTest();
    expect(() => signPodJwt({ audience: CP, purpose: "relay" }, {})).toThrow(
      expect.objectContaining({ code: "POD_IDENTITY_MISSING" })
    );
    process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey("p384.pem", "secp384r1");
    _resetPodIdentityForTest();
    expect(() => getPodJwks()).toThrow(
      expect.objectContaining({ code: "POD_IDENTITY_INVALID" })
    );
    process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey("ok.pem");
    delete process.env.PUBLIC_URL;
    _resetPodIdentityForTest();
    expect(() => signPodJwt({ audience: CP, purpose: "relay" }, {})).toThrow(
      expect.objectContaining({ code: "POD_IDENTITY_NO_PUBLIC_URL" })
    );
  });
});

describe("GET /.well-known/synap-pod-jwks", () => {
  it("serves the public key only, cacheable", async () => {
    const res = await podIdentityJwksApp.request(POD_JWKS_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("public");
    const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      kid: getPodKeyId(),
    });
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("a pod with no key answers 503 POD_IDENTITY_MISSING, never an empty key set", async () => {
    process.env.SYNAP_POD_IDENTITY_KEY_FILE = path.join(dir, "nope.pem");
    _resetPodIdentityForTest();
    const res = await podIdentityJwksApp.request(POD_JWKS_PATH);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "POD_IDENTITY_MISSING" });
  });
});
