"use strict";

// A pod archive may run for as long as the control plane waits for it
// (ARCHIVE_MAX_RUN_MS in the CP's services/provisioning/archive-manifest.ts,
// a mirror pinned here): with the 10-minute default of the other commands,
// pod-agent killed a long archive half-way while the CP still waited.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ARCHIVE_MAX_RUN_MS } = require("./archive-manifest");

test("the archive run limit is the control plane's (60 min)", () => {
  assert.equal(ARCHIVE_MAX_RUN_MS, 60 * 60_000);
});

// server.js listens on load, so its wiring is asserted at the source (as in
// configure-env.test.js): the archive command runs under that limit, and
// every command's execFile takes its own command's timeout.
test("server.js runs the archive command under ARCHIVE_MAX_RUN_MS", () => {
  const src = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  const archive = /\n {2}archive: \{\n([\s\S]*?)\n {2}\},\n/.exec(src);
  assert.ok(archive, "COMMANDS.archive not found in server.js");
  assert.match(archive[1], /\n {4}timeout: ARCHIVE_MAX_RUN_MS,/);
  assert.match(src, /timeout: cmd\.timeout \?\? 600_000/);
});
