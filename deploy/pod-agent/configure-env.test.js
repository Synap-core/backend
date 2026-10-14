"use strict";

// H6 (security wave 2026-10-13): a signed `configure` could smuggle a second
// KEY=VALUE line through a newline in a value (configure-pod.sh writes each
// argument as one line of the pairs file env-config.sh reads line by line),
// and could set the agent's own trust anchors / immutable secrets.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  CONFIGURE_NEVER_KEYS,
  commandErrorStatus,
  configureEnvEntries,
  parseImmutableEnvKeys,
  validateConfigurePayload,
} = require("./trust");

// The REAL schema the pod ships — the immutable set is derived, never listed here.
const SCHEMA = fs.readFileSync(
  path.join(__dirname, "..", "env.schema"),
  "utf8"
);
const IMMUTABLE = parseImmutableEnvKeys(SCHEMA);

function statusFor(payload, immutable = IMMUTABLE) {
  try {
    validateConfigurePayload(payload, immutable);
    return 202;
  } catch (error) {
    return commandErrorStatus(error);
  }
}

test("the immutable set is derived from env.schema and is not vacuous", () => {
  assert.ok(
    IMMUTABLE.exact.size >= 5,
    `expected several immutable keys, got ${IMMUTABLE.exact.size}`
  );
  // literal samples the scan must still see
  assert.ok(IMMUTABLE.exact.has("PROVISIONING_TOKEN"));
  assert.ok(IMMUTABLE.exact.has("JWT_SECRET"));
  assert.ok(!IMMUTABLE.exact.has("PUBLIC_URL"));
});

test("every key the Control Plane sends via configure stays accepted", () => {
  // claim-warm-pod.ts, backup-vault, pod-email-relay
  assert.equal(
    statusFor({
      envVars: [
        "DOMAIN=claimed.example.com",
        "PUBLIC_URL=https://claimed.example.com",
        "POD_ADMIN_DOMAIN=pod-admin.claimed.example.com",
        "POD_ADMIN_URL=https://pod-admin.claimed.example.com",
        "FRONTEND_URL=https://claimed.example.com",
        "CORS_ORIGIN=https://claimed.example.com",
        "ALLOWED_ORIGINS=https://claimed.example.com",
        "POD_AGENT_AUDIENCE=https://claimed.example.com",
      ],
      profiles: [],
      recreate: ["caddy", "backend", "kratos", "pod-admin", "pod-agent"],
    }),
    202
  );
  // An older Control Plane's retired OpenClaw add-on payload (keys now
  // `retired` in env.schema, a profile no service carries) is still accepted:
  // env-config.sh drops the retired keys, compose ignores the empty profile.
  assert.equal(
    statusFor({
      envVars: {
        OPENCLAW_HUB_API_KEY: "test-key-1",
        SYNAP_AGENT_USER_ID: "u",
        SYNAP_WORKSPACE_ID: "w",
      },
      profiles: ["openclaw"],
    }),
    202
  );
  assert.equal(
    statusFor({
      envVars: [
        "BACKUP_REPOSITORY=b2:bucket:pods/p",
        "BACKUP_B2_ACCOUNT_ID=test-id",
        "BACKUP_B2_ACCOUNT_KEY=test-secret",
        "SMTP_CONNECTION_URI=smtps://resend:test@smtp.resend.com:465",
        "SMTP_FROM_ADDRESS=pod@example.com",
      ],
    }),
    202
  );
  assert.equal(statusFor({}), 202); // profiles-only / no env
});

test("a newline, carriage return or NUL in a value is refused (no second pair)", () => {
  for (const value of [
    "x\nPOD_AGENT_ISSUER_URL=https://evil.example",
    "x\rPOD_AGENT_ISSUER_URL=https://evil.example",
    "x\0y",
  ]) {
    assert.equal(statusFor({ envVars: [`DEBUG=${value}`] }), 400);
    assert.equal(statusFor({ envVars: { DEBUG: value } }), 400);
  }
  // a newline smuggled through an object KEY lands in the value half
  assert.equal(
    statusFor({ envVars: { "DEBUG=1\nCONTROL_PLANE_URL": "https://evil" } }),
    400
  );
});

test("keys must be plain env names", () => {
  for (const entry of [
    "debug=1",
    "1DEBUG=1",
    "DE-BUG=1",
    "--profile=x",
    " DEBUG=1",
    "=1",
    "DEBUG",
  ]) {
    assert.equal(statusFor({ envVars: [entry] }), 400, entry);
  }
  assert.equal(statusFor({ envVars: [42] }), 400);
  assert.equal(statusFor({ envVars: ["DEBUG=1", "DEBUG=2"] }), 400);
});

test("trust anchors and immutable secrets cannot be set by a command", () => {
  for (const key of CONFIGURE_NEVER_KEYS) {
    assert.equal(statusFor({ envVars: [`${key}=https://x.example`] }), 400);
    assert.equal(statusFor({ envVars: [`${key}=`] }), 400, `${key} empty`);
  }
  for (const key of IMMUTABLE.exact) {
    assert.equal(statusFor({ envVars: [`${key}=test-secret-x`] }), 400, key);
  }
});

test("POD_AGENT_AUDIENCE moves only together with a matching PUBLIC_URL", () => {
  assert.equal(
    statusFor({ envVars: ["POD_AGENT_AUDIENCE=https://a.example"] }),
    400
  );
  assert.equal(statusFor({ envVars: ["PUBLIC_URL=https://a.example"] }), 400);
  assert.equal(
    statusFor({
      envVars: [
        "PUBLIC_URL=https://a.example",
        "POD_AGENT_AUDIENCE=https://b.example",
      ],
    }),
    400
  );
});

test("profiles and recreate must be compose names", () => {
  assert.equal(statusFor({ profiles: ["rsshub\n--force"] }), 400);
  assert.equal(statusFor({ recreate: ["--remove-orphans"] }), 400);
  assert.equal(statusFor({ recreate: "backend" }), 400);
});

test("an unreadable or empty schema refuses env writes (fail closed)", () => {
  assert.equal(statusFor({ envVars: ["DEBUG=1"] }, null), 503);
  assert.equal(
    statusFor({ envVars: ["DEBUG=1"] }, parseImmutableEnvKeys("")),
    503
  );
  // nothing to write ⇒ nothing to check against
  assert.equal(statusFor({ profiles: ["rsshub"] }, null), 202);
});

test("errors never echo a value", () => {
  try {
    validateConfigurePayload(
      { envVars: ["DEBUG=test-secret-VALUE\nX=1"] },
      IMMUTABLE
    );
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(!String(error.message).includes("test-secret-VALUE"));
  }
});

test("args and validation read the same entries", () => {
  assert.deepEqual(configureEnvEntries({ envVars: { A: 1 } }), ["A=1"]);
  assert.deepEqual(configureEnvEntries({ envVars: ["A=1"] }), ["A=1"]);
  assert.deepEqual(configureEnvEntries({}), []);
});

// server.js listens on load, so its wiring is asserted at the source: the
// configure command is validated against env.schema before dispatch, and the
// script's argv is built from the SAME entries the validator read.
test("server.js wires configure validation and builds argv from the checked entries", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const validate = src.slice(src.indexOf("function validateCommandPayload"));
  assert.match(
    validate.slice(0, 400),
    /validateConfigurePayload\(payload, readImmutableEnvKeys\(\)\)/
  );
  assert.match(src, /path\.join\(DEPLOY_DIR, "env\.schema"\)/);
  const configure = src.slice(src.indexOf("configure: {"));
  assert.match(
    configure.slice(0, 400),
    /const envVars = configureEnvEntries\(p\);/
  );
  // no second, unchecked conversion of envVars survives in server.js
  assert.doesNotMatch(src, /Object\.entries\(p(ayload)?\.envVars\)/);
});
