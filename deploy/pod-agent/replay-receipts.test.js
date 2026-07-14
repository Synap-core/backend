"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  consumePodAgentReceipt,
  receiptFileName,
} = require("./replay-receipts");

function makeStateDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "synap-pod-agent-receipts-"));
}

test("consumes one issuer-qualified command ID across agent restarts", () => {
  const directory = makeStateDirectory();
  const input = {
    directory,
    issuerUrl: "https://issuer.example",
    jti: "signed-command-1",
    expiresAt: 20_000,
    now: 10_000,
  };

  assert.equal(consumePodAgentReceipt(input), "consumed");
  assert.equal(consumePodAgentReceipt(input), "replayed");
  assert.equal(
    consumePodAgentReceipt({
      ...input,
      jti: "signed-command-1",
      issuerUrl: "https://other.example",
    }),
    "consumed"
  );
});

test("syncs the receipt directory after syncing the receipt file", () => {
  const directory = makeStateDirectory();
  const originalFsync = fs.fsyncSync;
  const synced = [];
  fs.fsyncSync = (descriptor) => {
    synced.push(fs.fstatSync(descriptor).isDirectory() ? "directory" : "file");
    return originalFsync(descriptor);
  };

  try {
    assert.equal(
      consumePodAgentReceipt({
        directory,
        issuerUrl: "https://issuer.example",
        jti: "durable-command",
        expiresAt: 20_000,
        now: 10_000,
      }),
      "consumed"
    );
  } finally {
    fs.fsyncSync = originalFsync;
  }

  assert.deepEqual(synced, ["file", "directory"]);
});

test("cleans expired receipts before accepting a new command ID", () => {
  const directory = makeStateDirectory();
  const issuerUrl = "https://issuer.example";
  const jti = "expired-command";
  const receiptPath = path.join(directory, receiptFileName(issuerUrl, jti));
  fs.writeFileSync(receiptPath, JSON.stringify({ expiresAt: 9_999 }));

  assert.equal(
    consumePodAgentReceipt({
      directory,
      issuerUrl,
      jti,
      expiresAt: 20_000,
      now: 10_000,
    }),
    "consumed"
  );
});
