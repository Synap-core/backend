/**
 * The IS delegation contract (D4, utils/is-delegation.ts) through its real
 * surface: a real P-256 key file, real ES256 signatures, the real
 * `verifyOwnPodJwt` door. Every refusal below is one a forged, stale or
 * misdirected token must hit before the hub auth ever reads `sub`.
 */

import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetPodIdentityForTest,
  getPodKeyId,
  PodIdentityError,
  signPodJwt,
} from "../pod-identity.js";
import {
  IS_DELEGATION_HEADER,
  IS_DELEGATION_MAX_LIFETIME_SECONDS,
  IS_DELEGATION_PURPOSE,
  isDelegationHeaders,
  mintIsDelegationToken,
  verifyIsDelegationToken,
} from "../is-delegation.js";

const IS = "https://intelligence.synap.test";
const POD = "https://pod.lab1.synap.test";
const dir = mkdtempSync(path.join(tmpdir(), "is-delegation-"));

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
  process.env.PUBLIC_URL = `${POD}/`;
  _resetPodIdentityForTest();
});
afterEach(() => {
  if (saved.file === undefined) delete process.env.SYNAP_POD_IDENTITY_KEY_FILE;
  else process.env.SYNAP_POD_IDENTITY_KEY_FILE = saved.file;
  if (saved.url === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = saved.url;
  _resetPodIdentityForTest();
});

const known = { isKnownAudience: (aud: string) => aud === IS };
const now = () => Math.floor(Date.now() / 1000);

function grant() {
  return {
    isUrl: `${IS}/some/path`,
    operatorUserId: "operator-1",
    agentUserId: "agent-1",
    channelId: "channel-1",
    runId: "run-1",
  };
}

async function refusal(
  token: string,
  options: Parameters<typeof verifyIsDelegationToken>[1] = known
): Promise<string> {
  try {
    await verifyIsDelegationToken(token, options);
  } catch (err) {
    expect(err).toBeInstanceOf(PodIdentityError);
    return (err as PodIdentityError).code;
  }
  throw new Error("expected the delegation to be refused");
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("IS delegation: mint → verify", () => {
  it("round-trips every claim, with aud = the IS origin and a 15-minute life", async () => {
    const token = mintIsDelegationToken(grant());
    const verified = await verifyIsDelegationToken(token, known);
    expect(verified).toMatchObject({
      operatorUserId: "operator-1",
      agentUserId: "agent-1",
      channelId: "channel-1",
      runId: "run-1",
      audience: IS,
      scopes: ["hub-protocol.read", "hub-protocol.write"],
    });
    expect(verified.expiresAt - now()).toBeGreaterThan(890);
    expect(verified.expiresAt - now()).toBeLessThanOrEqual(900);
    expect(verified.maxExpiresAt - now()).toBeGreaterThan(
      IS_DELEGATION_MAX_LIFETIME_SECONDS - 10
    );
  });

  it("is multi-use within its life (one turn, many hub calls)", async () => {
    const token = mintIsDelegationToken(grant());
    const a = await verifyIsDelegationToken(token, known);
    const b = await verifyIsDelegationToken(token, known);
    expect(a.jti).toBe(b.jti);
  });

  it("isDelegationHeaders carries it under the pod→IS header", async () => {
    const headers = isDelegationHeaders(grant());
    const token = headers[IS_DELEGATION_HEADER];
    expect(token).toBeTruthy();
    expect((await verifyIsDelegationToken(token, known)).operatorUserId).toBe(
      "operator-1"
    );
  });
});

describe("IS delegation: refusals", () => {
  it("a forged signature (another key, this pod's kid) → POD_JWT_INVALID", async () => {
    const token = mintIsDelegationToken(grant());
    const [h, p] = token.split(".");
    const other = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const sig = crypto
      .sign("sha256", Buffer.from(`${h}.${p}`), {
        key: other.privateKey,
        dsaEncoding: "ieee-p1363",
      })
      .toString("base64url");
    expect(await refusal(`${h}.${p}.${sig}`)).toBe("POD_JWT_INVALID");
  });

  it("a payload edited after signing (another operator) → POD_JWT_INVALID", async () => {
    const token = mintIsDelegationToken(grant());
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.sub = "someone-else";
    expect(await refusal(`${h}.${b64(payload)}.${s}`)).toBe("POD_JWT_INVALID");
  });

  it("a token signed by a key this pod no longer holds → POD_JWT_INVALID", async () => {
    const token = mintIsDelegationToken(grant());
    process.env.SYNAP_POD_IDENTITY_KEY_FILE = writeKey();
    _resetPodIdentityForTest();
    expect(await refusal(token)).toBe("POD_JWT_INVALID");
  });

  it("a wrong audience (an AI service this pod does not use) → POD_JWT_INVALID", async () => {
    const token = mintIsDelegationToken(grant());
    expect(await refusal(token, { isKnownAudience: () => false })).toBe(
      "POD_JWT_INVALID"
    );
  });

  it("expired → POD_JWT_EXPIRED", async () => {
    const token = mintIsDelegationToken(grant());
    expect(await refusal(token, { ...known, nowSeconds: now() + 901 })).toBe(
      "POD_JWT_EXPIRED"
    );
  });

  it("a life that outruns its max_exp → POD_JWT_INVALID", async () => {
    const t = now();
    const token = signPodJwt(
      { audience: IS, purpose: IS_DELEGATION_PURPOSE },
      { sub: "operator-1", scope: "hub-protocol.read", max_exp: t + 60 },
      600
    );
    expect(await refusal(token)).toBe("POD_JWT_INVALID");
  });

  it("a max_exp beyond the 2-hour bound → POD_JWT_INVALID", async () => {
    const t = now();
    const token = signPodJwt(
      { audience: IS, purpose: IS_DELEGATION_PURPOSE },
      {
        sub: "operator-1",
        scope: "hub-protocol.read",
        max_exp: t + IS_DELEGATION_MAX_LIFETIME_SECONDS + 600,
      },
      600
    );
    expect(await refusal(token)).toBe("POD_JWT_INVALID");
  });

  it("a pod→CP token (another purpose) handed back → POD_JWT_INVALID", async () => {
    const token = signPodJwt(
      { audience: IS, purpose: "invites" },
      { sub: "operator-1", scope: "hub-protocol.read", max_exp: now() + 600 },
      120
    );
    expect(await refusal(token)).toBe("POD_JWT_INVALID");
  });

  it("a scope beyond read/write → POD_JWT_INVALID", async () => {
    const token = signPodJwt(
      { audience: IS, purpose: IS_DELEGATION_PURPOSE },
      { sub: "operator-1", scope: "hub-protocol.admin", max_exp: now() + 600 },
      600
    );
    expect(await refusal(token)).toBe("POD_JWT_INVALID");
  });

  it("no operator → POD_JWT_INVALID", async () => {
    const token = signPodJwt(
      { audience: IS, purpose: IS_DELEGATION_PURPOSE },
      { scope: "hub-protocol.read", max_exp: now() + 600 },
      600
    );
    expect(await refusal(token)).toBe("POD_JWT_INVALID");
  });
});

describe("IS delegation: the signer's lifetime ceilings", () => {
  it("is_delegation may live 900 s; a CP-bound purpose stays at 300 s", () => {
    expect(() =>
      signPodJwt({ audience: IS, purpose: IS_DELEGATION_PURPOSE }, {}, 900)
    ).not.toThrow();
    expect(() =>
      signPodJwt({ audience: IS, purpose: IS_DELEGATION_PURPOSE }, {}, 901)
    ).toThrow(PodIdentityError);
    expect(() =>
      signPodJwt({ audience: IS, purpose: "invites" }, {}, 301)
    ).toThrow(PodIdentityError);
  });
});

describe("IS delegation: minting condition (key file present)", () => {
  it("a pod with no identity key file sends no token — the transition path", () => {
    process.env.SYNAP_POD_IDENTITY_KEY_FILE = path.join(dir, "absent.pem");
    _resetPodIdentityForTest();
    expect(isDelegationHeaders(grant())).toEqual({});
  });

  it("an enrollment record is NOT required (the pod verifies its own token)", async () => {
    // No SYNAP_POD_IDENTITY_ENROLLMENT_FILE anywhere in this suite.
    expect(getPodKeyId()).toBeTruthy();
    const token = isDelegationHeaders(grant())[IS_DELEGATION_HEADER];
    expect(token).toBeTruthy();
  });
});
