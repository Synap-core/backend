/**
 * POST /.well-known/synap-pod-proof through its real surface: a real P-256 key
 * file on disk, the real route, and a verifier that knows ONLY what a client
 * knows (the key served at `/.well-known/synap-pod-jwks`). It mirrors what the
 * app-bases helper checks before an app follows a moved pod (plan 5b923276
 * D3): ES256 under the JWKS key, `kid`, `typ`, `iss` = the pod's origin, `aud`,
 * the nonce the client chose, a 60 s lifetime.
 */

import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyOwnPodJwt } from "@synap/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPodIdentityForTest,
  getPodKeyId,
  POD_JWT_TYP,
  POD_PROOF_AUDIENCE,
  POD_PROOF_TYP,
  signPodProof,
} from "../pod-identity.js";
import {
  podIdentityJwksApp,
  POD_JWKS_PATH,
  POD_PROOF_PATH,
} from "../../routers/pod-identity-jwks.js";

const ORIGIN = "https://pod.lab1.synap.test";
const dir = mkdtempSync(path.join(tmpdir(), "pod-proof-"));

function writeKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const file = path.join(dir, `k-${crypto.randomUUID()}.pem`);
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
  process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey();
  process.env.PUBLIC_URL = `${ORIGIN}/`;
  _resetPodIdentityForTest();
});
afterEach(() => {
  if (saved.file === undefined) delete process.env.SYNAP_POD_IDENTITY_KEY_FILE;
  else process.env.SYNAP_POD_IDENTITY_KEY_FILE = saved.file;
  if (saved.url === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = saved.url;
  _resetPodIdentityForTest();
});

const nonceOf = (bytes: number) =>
  crypto.randomBytes(bytes).toString("base64url");

function postProof(body: unknown, headers: Record<string, string> = {}) {
  return podIdentityJwksApp.request(POD_PROOF_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** What a client does: the key from the JWKS route, then the JWS checks. */
async function verifyAsClient(proof: string) {
  const jwksRes = await podIdentityJwksApp.request(POD_JWKS_PATH);
  const { keys } = (await jwksRes.json()) as { keys: crypto.JsonWebKey[] };
  const key = crypto.createPublicKey({ key: keys[0]!, format: "jwk" });
  const [h, p, s] = proof.split(".");
  const ok = crypto.verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(s!, "base64url")
  );
  return {
    ok,
    header: JSON.parse(Buffer.from(h!, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(p!, "base64url").toString("utf8")),
  };
}

describe("POST /.well-known/synap-pod-proof", () => {
  it("signs the client's nonce with the key the JWKS serves: ES256, kid, typ, iss, aud, nonce, 60 s", async () => {
    const nonce = nonceOf(32);
    const res = await postProof({ nonce });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const { proof } = (await res.json()) as { proof: string };
    expect(proof.split(".")).toHaveLength(3);

    const { ok, header, payload } = await verifyAsClient(proof);
    expect(ok).toBe(true);
    expect(header).toEqual({
      alg: "ES256",
      kid: getPodKeyId(),
      typ: POD_PROOF_TYP,
    });
    expect(payload).toEqual({
      iss: ORIGIN,
      aud: POD_PROOF_AUDIENCE,
      nonce,
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    expect(payload.exp - payload.iat).toBe(60);
    expect(Math.abs(payload.iat - Date.now() / 1000)).toBeLessThan(5);
  });

  it("each nonce gets its own proof; a proof under another key does not verify with this pod's JWKS", async () => {
    const a = nonceOf(16);
    const b = nonceOf(64);
    const pa = (
      (await (await postProof({ nonce: a })).json()) as { proof: string }
    ).proof;
    const pb = (
      (await (await postProof({ nonce: b })).json()) as { proof: string }
    ).proof;
    expect((await verifyAsClient(pa)).payload.nonce).toBe(a);
    expect((await verifyAsClient(pb)).payload.nonce).toBe(b);

    // The impostor: same JWKS served (it is public), another key signing.
    const jwks = (await (
      await podIdentityJwksApp.request(POD_JWKS_PATH)
    ).json()) as {
      keys: crypto.JsonWebKey[];
    };
    process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey();
    _resetPodIdentityForTest();
    const forged = signPodProof(a);
    const key = crypto.createPublicKey({ key: jwks.keys[0]!, format: "jwk" });
    const [h, p, s] = forged.split(".");
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(`${h}.${p}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(s!, "base64url")
      )
    ).toBe(false);
  });

  it("refuses anything that is not { nonce: 16–64 bytes of unpadded base64url } with 400 POD_PROOF_BAD_NONCE", async () => {
    const sixteen = crypto.randomBytes(16);
    const bad: unknown[] = [
      {},
      { nonce: 42 },
      { nonce: "" },
      { nonce: nonceOf(15) },
      { nonce: nonceOf(65) },
      { nonce: `${sixteen.toString("base64url")}==` }, // padded
      { nonce: "+".repeat(22) }, // standard base64, not base64url
      { nonce: `${nonceOf(16)}.` },
      [nonceOf(16)],
      "not json",
      "null",
    ];
    for (const body of bad) {
      const res = await postProof(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.json()).toMatchObject({ code: "POD_PROOF_BAD_NONCE" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("a body far larger than a nonce is refused before it is read (413)", async () => {
    const res = await postProof({ nonce: nonceOf(16), pad: "x".repeat(4096) });
    expect(res.status).toBe(413);
  });

  it("reads no credential: a Cookie or Bearer changes nothing", async () => {
    const nonce = nonceOf(24);
    const res = await postProof(
      { nonce },
      { Cookie: "ory_kratos_session=abc", Authorization: "Bearer synap_x" }
    );
    expect(res.status).toBe(200);
    const { proof } = (await res.json()) as { proof: string };
    expect((await verifyAsClient(proof)).ok).toBe(true);
  });

  it("a proof is never a pod token: the pod's own verifier refuses it", async () => {
    expect(POD_PROOF_TYP).not.toBe(POD_JWT_TYP);
    const proof = signPodProof(nonceOf(32));
    expect(() => verifyOwnPodJwt(proof, "is_delegation")).toThrow(
      expect.objectContaining({ code: "POD_JWT_INVALID" })
    );
  });

  it("a pod with no key answers 503 POD_IDENTITY_MISSING, never an unsigned answer", async () => {
    process.env.SYNAP_POD_IDENTITY_KEY_FILE = path.join(dir, "nope.pem");
    _resetPodIdentityForTest();
    const res = await postProof({ nonce: nonceOf(32) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "POD_IDENTITY_MISSING" });
  });

  it("only POST: a GET is not the proof route", async () => {
    const res = await podIdentityJwksApp.request(POD_PROOF_PATH);
    expect(res.status).toBe(404);
  });
});
