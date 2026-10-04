"use strict";

// update-door plan P0 (2026-10-04): a pod-agent `update` with no targetVersion
// used to run update-pod.sh with "latest". It must be a 400, never a pull of a
// mutable tag.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  commandErrorStatus,
  validateUpdateTargetVersion,
} = require("./trust");

function statusFor(payload) {
  try {
    validateUpdateTargetVersion(payload);
    return 202;
  } catch (error) {
    return commandErrorStatus(error);
  }
}

test("missing / empty / non-string targetVersion is a 400", () => {
  assert.equal(statusFor({}), 400);
  assert.equal(statusFor({ targetVersion: "" }), 400);
  assert.equal(statusFor({ targetVersion: null }), 400);
  assert.equal(statusFor({ targetVersion: 42 }), 400);
});

test("a tag that could break out of update-pod.sh's sed is a 400", () => {
  assert.equal(statusFor({ targetVersion: "v1/../../x" }), 400);
  assert.equal(statusFor({ targetVersion: "v1;rm -rf /" }), 400);
  assert.equal(statusFor({ targetVersion: "-v1" }), 400);
});

test("an explicit tag is accepted and passed through unchanged", () => {
  assert.equal(validateUpdateTargetVersion({ targetVersion: "main-302ef50" }), "main-302ef50");
  assert.equal(validateUpdateTargetVersion({ targetVersion: "v1.2.3" }), "v1.2.3");
});

test("other errors keep their status", () => {
  assert.equal(commandErrorStatus(new Error("bad signature")), 403);
  assert.equal(commandErrorStatus(Object.assign(new Error("x"), { code: "REPLAY_PROTECTION_UNAVAILABLE" })), 503);
});

// server.js listens on load, so assert its wiring at the source: the update
// command validates BEFORE the receipt is consumed and the script is spawned,
// the catch maps errors through commandErrorStatus, and no `|| "latest"` fallback
// survives anywhere in the file.
test("server.js wires the validation into the command door", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.doesNotMatch(src, /\|\|\s*["']latest["']/);
  const validate = src.slice(src.indexOf("function validateCommandPayload"));
  assert.match(validate.slice(0, 300), /commandName === "update"[\s\S]*validateUpdateTargetVersion\(payload\)/);
  const door = src.slice(src.indexOf("validateCommandPayload(commandName, payload);"));
  assert.ok(door.indexOf("consumeSignedCommandReceipt") > 0, "validation runs before the receipt is consumed");
  assert.match(door, /respond\(res, commandErrorStatus\(e\)/);
  assert.match(src, /args: \(p\) => \[validateUpdateTargetVersion\(p\)\]/);
});
