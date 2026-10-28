"use strict";

// D3: the pod owner's local policy is the consent line for archive /
// restore-archive / configure on a self-hosted pod; D15: an archive needs an
// age recipient. D2: pulled (pod-command) tokens never ride the push route,
// and a CP `configure` can never re-open push.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  SELF_HOSTED_REFUSALS,
  assertCommandAllowed,
  readPodAgentPolicy,
} = require("./policy");
const {
  CONFIGURE_NEVER_KEYS,
  assertPushable,
  commandErrorStatus,
  isPushEnabled,
  parseImmutableEnvKeys,
  resolveCommandName,
  validateConfigurePayload,
} = require("./trust");

const RECIPIENT =
  "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

function policyAt(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-agent-policy-"));
  const file = path.join(dir, "pod-agent-policy.json");
  if (content !== undefined) fs.writeFileSync(file, content);
  return readPodAgentPolicy(file);
}

function verdict(policy, command) {
  try {
    assertCommandAllowed(policy, command);
    return "allowed";
  } catch (error) {
    return error.code;
  }
}

test("no policy file = self-hosted: archive, restore-archive and configure are refused", () => {
  const policy = policyAt(undefined);
  assert.equal(policy.source, "default");
  assert.equal(policy.mode, "self-hosted");
  assert.deepEqual([...SELF_HOSTED_REFUSALS].sort(), [
    "archive",
    "configure",
    "restore-archive",
  ]);
  for (const command of SELF_HOSTED_REFUSALS) {
    assert.equal(verdict(policy, command), "POD_POLICY_REFUSED", command);
  }
  for (const command of ["update", "suspend", "restore", "agent-update"]) {
    assert.equal(verdict(policy, command), "allowed", command);
  }
});

test("managed allows every command (an archive still needs a recipient)", () => {
  const policy = policyAt(
    JSON.stringify({ mode: "managed", archiveRecipients: [RECIPIENT] })
  );
  assert.equal(policy.error, null);
  for (const command of ["configure", "restore-archive", "archive", "update"]) {
    assert.equal(verdict(policy, command), "allowed", command);
  }
});

test("D15: archive with no recipient is a typed refusal, even when managed", () => {
  const policy = policyAt(JSON.stringify({ mode: "managed" }));
  assert.equal(verdict(policy, "archive"), "ARCHIVE_RECIPIENT_MISSING");
  assert.equal(verdict(policy, "configure"), "allowed");
});

test("an owner's explicit refuse list replaces the mode default", () => {
  const policy = policyAt(
    JSON.stringify({ mode: "self-hosted", refuse: ["update"] })
  );
  assert.equal(verdict(policy, "update"), "POD_POLICY_REFUSED");
  assert.equal(verdict(policy, "configure"), "allowed");
});

test("an unusable policy file fails CLOSED to the self-hosted refusals", () => {
  for (const content of [
    "{not json",
    JSON.stringify({ mode: "owner-knows-best" }),
    JSON.stringify({ mode: "managed", refuse: "archive" }),
    JSON.stringify({
      mode: "managed",
      archiveRecipients: ["ssh-ed25519 AAAA"],
    }),
    JSON.stringify(["managed"]),
  ]) {
    const policy = policyAt(content);
    assert.equal(policy.error, "POD_POLICY_INVALID", content);
    assert.equal(verdict(policy, "configure"), "POD_POLICY_REFUSED", content);
    assert.equal(verdict(policy, "update"), "allowed", content);
  }
});

test("policy refusals map to HTTP statuses on the push route", () => {
  const status = (policy, command) => {
    try {
      assertCommandAllowed(policy, command);
      return 202;
    } catch (error) {
      return commandErrorStatus(error);
    }
  };
  assert.equal(status(policyAt(undefined), "configure"), 403);
  assert.equal(
    status(policyAt(JSON.stringify({ mode: "managed" })), "archive"),
    409
  );
});

test("a pod-command token names its operation in `command`, and is never pushable", () => {
  const pulled = { type: "pod-command", command: "archive" };
  assert.equal(resolveCommandName(pulled), "archive");
  assert.throws(
    () => resolveCommandName({ type: "pod-command" }),
    /missing command claim/
  );
  assert.throws(() => assertPushable(pulled), { code: "COMMAND_NOT_PUSHABLE" });
  // Legacy pushed tokens keep working.
  assert.doesNotThrow(() => assertPushable({ type: "archive" }));
  assert.equal(resolveCommandName({ type: "archive" }), "archive");
});

test("push is on by default and off only on an explicit 0/false", () => {
  assert.equal(isPushEnabled({}), true);
  assert.equal(isPushEnabled({ POD_AGENT_PUSH_ENABLED: "1" }), true);
  assert.equal(isPushEnabled({ POD_AGENT_PUSH_ENABLED: "0" }), false);
  assert.equal(isPushEnabled({ POD_AGENT_PUSH_ENABLED: "false" }), false);
});

test("a CP configure can never set POD_AGENT_PUSH_ENABLED", () => {
  assert.ok(CONFIGURE_NEVER_KEYS.includes("POD_AGENT_PUSH_ENABLED"));
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "env.schema"),
    "utf8"
  );
  assert.throws(
    () =>
      validateConfigurePayload(
        { envVars: ["POD_AGENT_PUSH_ENABLED=1"] },
        parseImmutableEnvKeys(schema)
      ),
    /POD_AGENT_PUSH_ENABLED cannot be changed by a command/
  );
});

// Audit 2026-10-28: the pushed GET /host-log and /docker-logs verified the token
// but never asked the owner's policy, so a self-hosted owner who refused
// "read-docker-logs" was still read. server.js listens on load, so its wiring is
// asserted at the source. The routes are DERIVED: every pushed name check
// (`resolveCommandName(payload) !== "<name>"`) must be followed by the policy
// check for that name, before the replay receipt is spent.
test("every pushed read asks the owner's policy before its receipt is spent", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const nameCheck = /resolveCommandName\(payload\) !== "([a-z][a-z0-9-]*)"/g;
  const names = [];
  for (const m of src.matchAll(nameCheck)) {
    const name = m[1];
    names.push(name);
    const rest = src.slice(m.index);
    const receipt = rest.indexOf("consumeSignedCommandReceipt(payload)");
    const asked = rest.search(
      new RegExp(
        `assertCommandAllowed\\(\\s*readPodAgentPolicy\\(policyFile\\(DEPLOY_DIR\\)\\),\\s*"${name}"\\s*\\)`
      )
    );
    assert.ok(receipt > 0, `${name}: no receipt check after the name check`);
    assert.ok(
      asked > 0 && asked < receipt,
      `${name}: the pushed route does not ask the owner's policy before spending the receipt`
    );
  }
  assert.deepEqual(names.sort(), ["read-docker-logs", "read-host-log"]);
});
