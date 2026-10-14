"use strict";

// The pod-agent mirrors the backend's ONE pod-signing door (plain node cannot
// import it). These tests pin the mirror to the door's SOURCE — header
// members, payload members, reserved claims, typ, max TTL — so a change to
// `signPodJwt` that the CP's verifyPodJwt then enforces cannot leave the
// pod-agent signing a token the CP refuses.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  POD_JWT_MAX_TTL_SECONDS,
  POD_JWT_TYP,
  RESERVED_CLAIMS,
  ecJwkThumbprint,
  loadPodIdentity,
  signPodJwt,
} = require("./pod-identity");

const DOOR = path.join(
  __dirname,
  "..",
  "..",
  "packages",
  "database",
  "src",
  "utils",
  "pod-identity.ts"
);

function readDoor() {
  return fs.readFileSync(DOOR, "utf8");
}

/** Member names of the object literal assigned to `const <name> = {…};`. */
function literalMembers(source, name) {
  const match = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`).exec(source);
  assert.ok(match, `the door's \`const ${name} = {…}\` was not found`);
  return match[1]
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith("...") ? part : part.split(":")[0].trim()));
}

function decodePart(token, index) {
  return JSON.parse(Buffer.from(token.split(".")[index], "base64url"));
}

function newKeyFile() {
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-identity-"));
  const file = path.join(dir, "pod-key.pem");
  fs.writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600,
  });
  return { file, privateKey };
}

const BINDING = {
  issuer: "https://pod.example.com",
  audience: "https://api.synap.live",
  purpose: "pod-commands.poll",
};

test("the backend signing door is where this mirror expects it (non-vacuity)", () => {
  const source = readDoor();
  assert.match(source, /export function signPodJwt\(/);
  assert.match(source, /const header = \{/);
  assert.match(source, /const payload = \{/);
});

test("typ and max TTL match the door", () => {
  const source = readDoor();
  assert.equal(
    /export const POD_JWT_TYP = "([^"]+)"/.exec(source)[1],
    POD_JWT_TYP
  );
  assert.equal(
    Number(/export const POD_JWT_MAX_TTL_SECONDS = (\d+)/.exec(source)[1]),
    POD_JWT_MAX_TTL_SECONDS
  );
});

test("reserved claims match the door", () => {
  const match = /const RESERVED_CLAIMS = \[([\s\S]*?)\]/.exec(readDoor());
  assert.ok(match, "RESERVED_CLAIMS not found in the door");
  const door = [...match[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(door.length >= 5, "door reserved-claim scan is vacuous");
  assert.deepEqual([...RESERVED_CLAIMS].sort(), door.sort());
});

test("a signed token has exactly the door's header and payload members", () => {
  const source = readDoor();
  const doorHeader = literalMembers(source, "header").sort();
  const doorPayload = literalMembers(source, "payload")
    .filter((m) => !m.startsWith("..."))
    .sort();
  assert.ok(doorPayload.includes("purpose"), "payload scan is vacuous");

  const { file } = newKeyFile();
  const token = signPodJwt(loadPodIdentity(file), BINDING, { commandId: "c1" });
  const header = decodePart(token, 0);
  const payload = decodePart(token, 1);
  assert.deepEqual(Object.keys(header).sort(), doorHeader);
  assert.deepEqual(
    Object.keys(payload)
      .filter((k) => k !== "commandId")
      .sort(),
    doorPayload
  );
  assert.equal(header.alg, "ES256");
  assert.equal(header.typ, "pod+jwt");
});

test("the token verifies under the pod's public key; kid is the RFC 7638 thumbprint", () => {
  const { file, privateKey } = newKeyFile();
  const identity = loadPodIdentity(file);
  const token = signPodJwt(identity, BINDING, {}, 60, 1_700_000_000_000);
  const [h, p, s] = token.split(".");
  const publicKey = crypto.createPublicKey(privateKey);
  assert.ok(
    crypto.verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url")
    )
  );
  const jwk = publicKey.export({ format: "jwk" });
  assert.equal(decodePart(token, 0).kid, ecJwkThumbprint(jwk));
  assert.deepEqual(
    (({ iss, aud, purpose, iat, exp }) => ({ iss, aud, purpose, iat, exp }))(
      decodePart(token, 1)
    ),
    {
      iss: "https://pod.example.com",
      aud: "https://api.synap.live",
      purpose: "pod-commands.poll",
      iat: 1_700_000_000,
      exp: 1_700_000_060,
    }
  );
});

test("refuses a caller-supplied reserved claim, a TTL over 300 s, no purpose", () => {
  const { file } = newKeyFile();
  const identity = loadPodIdentity(file);
  const code = (fn) => {
    try {
      fn();
      return "signed";
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(
    code(() => signPodJwt(identity, BINDING, { aud: "https://evil.example" })),
    "POD_JWT_BAD_REQUEST"
  );
  assert.equal(
    code(() => signPodJwt(identity, BINDING, {}, 301)),
    "POD_JWT_BAD_REQUEST"
  );
  assert.equal(
    code(() => signPodJwt(identity, { ...BINDING, purpose: "" })),
    "POD_JWT_BAD_REQUEST"
  );
});

test("a missing or non-P-256 key file is a typed error", () => {
  const code = (fn) => {
    try {
      fn();
      return "loaded";
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(
    code(() => loadPodIdentity("/nonexistent/pod-key.pem")),
    "POD_IDENTITY_MISSING"
  );
  const { privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "secp384r1",
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-identity-"));
  const file = path.join(dir, "pod-key.pem");
  fs.writeFileSync(file, privateKey.export({ format: "pem", type: "pkcs8" }));
  assert.equal(
    code(() => loadPodIdentity(file)),
    "POD_IDENTITY_INVALID"
  );
});
