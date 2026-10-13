#!/usr/bin/env node
/**
 * Regenerates test-vectors.json with node:crypto DIRECTLY (not through
 * src/index.ts), so the vectors are an independent oracle for the envelope.
 * Keys and IVs are derived from public labels: they are TEST keys, never used
 * for real data. Output is deterministic; re-running must produce no diff.
 */
import { createCipheriv, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const derive = (label, bytes) =>
  createHash("sha256")
    .update(`synap-field-crypto/test-vector/${label}`)
    .digest()
    .subarray(0, bytes);

const keys = [
  { kid: "tv2026b", key: derive("key/tv2026b", 32).toString("base64") },
  { kid: "tv2026a", key: derive("key/tv2026a", 32).toString("base64") },
];

const cases = [
  {
    kid: "tv2026b",
    aad: "synap/cp/data_pods.intelligence_api_key/6f1c2a7e-0000-4000-8000-000000000001",
    plaintext: "test-secret-hub-key-0001",
  },
  {
    kid: "tv2026a",
    aad: "synap/cp/pod_mcp_grants.encrypted_hub_key/grant_abc123",
    plaintext: "test-secret-older-key",
  },
  { kid: "tv2026b", aad: "synap/pod/service_keys.value", plaintext: "" },
  {
    kid: "tv2026b",
    aad: "synap/is/customer_refs.hub_protocol_api_key/42",
    plaintext: "unicode ✓ — é 日本",
  },
];

const vectors = cases.map((c, i) => {
  const key = Buffer.from(keys.find((k) => k.kid === c.kid).key, "base64");
  const iv = derive(`iv/${i}`, 12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(c.aad, "utf8"));
  const ct = Buffer.concat([
    cipher.update(c.plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const envelope = [
    "senc",
    "1",
    c.kid,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(":");
  return { ...c, envelope };
});

const out = {
  description:
    "Conformance vectors for the senc:1 envelope (AES-256-GCM, 12-byte IV, AAD). TEST KEYS ONLY. Every consumer must decrypt each `vectors` entry to its plaintext, and refuse each `mustFail` entry.",
  keyring: keys.map((k) => `${k.kid}:${k.key}`).join(","),
  vectors,
  mustFail: [
    {
      reason: "wrong AAD (row swap)",
      envelope: vectors[0].envelope,
      aad: "synap/cp/data_pods.intelligence_api_key/6f1c2a7e-0000-4000-8000-000000000002",
    },
    {
      reason: "wrong AAD (column swap)",
      envelope: vectors[1].envelope,
      aad: "synap/cp/data_pods.intelligence_api_key/grant_abc123",
    },
    {
      reason: "tampered tag",
      envelope: vectors[0].envelope.replace(
        /:[^:]+$/,
        ":" + Buffer.alloc(16).toString("base64url"),
      ),
      aad: vectors[0].aad,
    },
    {
      reason: "unknown kid",
      envelope: vectors[0].envelope.replace(":tv2026b:", ":tv1999z:"),
      aad: vectors[0].aad,
    },
    {
      reason: "unsupported version",
      envelope: vectors[0].envelope.replace("senc:1:", "senc:2:"),
      aad: vectors[0].aad,
    },
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(
  join(here, "..", "test-vectors.json"),
  JSON.stringify(out, null, 2) + "\n",
);
console.log(
  `wrote ${vectors.length} vectors, ${out.mustFail.length} must-fail cases`,
);
