"use strict";

// A signing-key rotation publishes a new kid next to the old one. The agent's
// 24 h JWKS cache used to refuse every command signed with the new kid until
// the cache expired. An unknown kid now forces one refetch, rate-limited.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createJwksKeyResolver } = require("./trust");

const URL_A = "https://issuer.example/.well-known/jwks.json";
const jwk = (kid) => ({ kid, kty: "EC", alg: "ES256" });

function harness(initialKids) {
  let kids = initialKids;
  let clock = 1_000_000;
  const fetches = [];
  const getKey = createJwksKeyResolver({
    fetchJson: async (url) => {
      fetches.push(url);
      return { keys: kids.map(jwk) };
    },
    createPublicKey: (k) => `key:${k.kid}`,
    now: () => clock,
  });
  return {
    getKey,
    fetches,
    rotate: (next) => (kids = next),
    advance: (ms) => (clock += ms),
  };
}

test("a known kid is served from the cache", async () => {
  const h = harness(["k1"]);
  assert.equal(await h.getKey(URL_A, "k1"), "key:k1");
  assert.equal(await h.getKey(URL_A, "k1"), "key:k1");
  assert.equal(h.fetches.length, 1);
});

test("an unknown kid on a fresh cache refetches once (rotation works at once)", async () => {
  const h = harness(["k1"]);
  await h.getKey(URL_A, "k1");
  h.advance(61_000);
  h.rotate(["k2", "k1"]);
  assert.equal(await h.getKey(URL_A, "k2"), "key:k2");
  assert.equal(h.fetches.length, 2);
  assert.equal(await h.getKey(URL_A, "k1"), "key:k1"); // grace key still served
  assert.equal(h.fetches.length, 2);
});

test("unknown kids are rate-limited — no JWKS amplification", async () => {
  const h = harness(["k1"]);
  await h.getKey(URL_A, "k1");
  h.advance(61_000);
  await assert.rejects(h.getKey(URL_A, "bogus-1"), /unknown signing key/);
  assert.equal(h.fetches.length, 2);
  for (let i = 0; i < 20; i++) {
    await assert.rejects(h.getKey(URL_A, `bogus-${i}`), /unknown signing key/);
  }
  assert.equal(h.fetches.length, 2);
  h.advance(61_000);
  await assert.rejects(h.getKey(URL_A, "bogus-x"), /unknown signing key/);
  assert.equal(h.fetches.length, 3);
});

test("a stale cache refetches regardless of the unknown-kid window", async () => {
  const h = harness(["k1"]);
  await h.getKey(URL_A, "k1");
  h.advance(86_400_001);
  await h.getKey(URL_A, "k1");
  assert.equal(h.fetches.length, 2);
});
