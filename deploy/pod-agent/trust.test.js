"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  normalizeHttpsUrl,
  resolveCommandName,
  resolvePodAgentTrust,
  validateSignedCommandClaims,
} = require("./trust");

const environment = {
  POD_AGENT_ISSUER_URL: "https://issuer.example",
  POD_AGENT_AUDIENCE: "https://pod.example",
};

function signedClaims(overrides = {}) {
  return {
    iss: environment.POD_AGENT_ISSUER_URL,
    aud: environment.POD_AGENT_AUDIENCE,
    iat: 10_000,
    exp: 10_600,
    jti: "command-1",
    command: "configure",
    ...overrides,
  };
}

test("requires exact canonical HTTPS settings", () => {
  assert.equal(
    normalizeHttpsUrl("https://issuer.example/team/"),
    "https://issuer.example/team"
  );
  assert.equal(normalizeHttpsUrl("http://issuer.example"), null);
  assert.equal(normalizeHttpsUrl("https://user@issuer.example"), null);
  assert.deepEqual(resolvePodAgentTrust(environment), {
    configured: true,
    issuerUrl: "https://issuer.example",
    audience: "https://pod.example",
    jwksUrl: "https://issuer.example/.well-known/jwks.json",
  });
  assert.equal(
    resolvePodAgentTrust({
      ...environment,
      POD_AGENT_AUDIENCE: "https://pod.example/",
    }).configured,
    false
  );
});

test("accepts only signed commands bound to this issuer and Pod audience", () => {
  const trust = resolvePodAgentTrust(environment);
  assert.equal(
    validateSignedCommandClaims(signedClaims(), trust, 10_100),
    "configure"
  );
  assert.equal(
    validateSignedCommandClaims(
      signedClaims({
        aud: ["https://other.example", environment.POD_AGENT_AUDIENCE],
      }),
      trust,
      10_100
    ),
    "configure"
  );

  for (const claims of [
    signedClaims({ iss: "https://other-issuer.example" }),
    signedClaims({ aud: "https://other-pod.example" }),
    signedClaims({ exp: 10_100 }),
    signedClaims({ iat: 10_161 }),
    signedClaims({ exp: 11_801 }),
    signedClaims({ jti: "" }),
  ]) {
    assert.throws(() => validateSignedCommandClaims(claims, trust, 10_100));
  }
});

test("uses command as the generic claim and retains only a conflict-safe type alias", () => {
  assert.equal(resolveCommandName({ command: "update" }), "update");
  assert.equal(resolveCommandName({ type: "update" }), "update");
  assert.equal(
    resolveCommandName({ command: "update", type: "update" }),
    "update"
  );
  assert.throws(() =>
    resolveCommandName({ command: "update", type: "archive" })
  );
});
