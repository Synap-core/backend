"use strict";

// Decision 7 (one update engine): pod-agent writes the host engine's request
// and reports the RECORDED outcome. Real files in a temp deploy dir, the real
// puller (pull.js) with only its HTTP `request` stubbed — the seam from the
// order to the two CP results is driven end to end.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCommandPuller } = require("./pull");
const {
  collectUpdateOutcome,
  pendingFile,
  queueUpdateRequest,
} = require("./update-request");

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pod-agent-update-"));
  const deployDir = path.join(root, "deploy");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(path.join(deployDir, "state"), { recursive: true });
  return {
    deployDir,
    stateDir,
    request: path.join(deployDir, "state", "requests", "update.json"),
    lastUpdate: path.join(deployDir, "state", "last-update.json"),
  };
}

const ORDER = { targetVersion: "main-abc1234", updateId: "upd-1" };

/** What synap `_ue_record` writes for an unattended run (with `request`). */
function record(d, status, extra = {}) {
  fs.writeFileSync(
    d.lastUpdate,
    JSON.stringify({
      ts: "2026-10-15T03:00:00Z",
      kind: "pod.update",
      status,
      from: "main-0000000",
      to: "main-abc1234",
      reason: status === "succeeded" ? "" : "image pull failed",
      dbRestored: false,
      backup: "",
      pod: "pod.example.com",
      request: "upd-1",
      ...extra,
    })
  );
}

test("queue: writes the host's request contract and answers queued", () => {
  const d = dirs();
  const r = queueUpdateRequest({ ...d, commandId: "cmd-1", payload: ORDER });
  assert.deepEqual(r, {
    status: "queued",
    version: "main-abc1234",
    data: { requestId: "upd-1" },
  });
  const req = JSON.parse(fs.readFileSync(d.request, "utf8"));
  assert.equal(req.schema, 1);
  assert.equal(req.release, "main-abc1234");
  assert.equal(req.id, "upd-1");
  assert.equal(req.requestedBy, "pod-agent");
  assert.ok(!Number.isNaN(Date.parse(req.requestedAt)));
  // The release passes the host's own regex (synap _UE_RELEASE_RE).
  const synap = fs.readFileSync(
    path.join(__dirname, "..", "..", "synap"),
    "utf8"
  );
  const hostRe = synap.match(/^_UE_RELEASE_RE='([^']+)'$/m);
  assert.ok(hostRe, "synap still defines _UE_RELEASE_RE");
  assert.match(req.release, new RegExp(hostRe[1]));
  const pending = JSON.parse(fs.readFileSync(pendingFile(d.stateDir), "utf8"));
  assert.equal(pending.commandId, "cmd-1");
  assert.equal(pending.requestId, "upd-1");
  // no temp file left beside the watched path
  assert.deepEqual(fs.readdirSync(path.dirname(d.request)), ["update.json"]);
});

test("the agent and the host refuse the same release ids", () => {
  const synap = fs.readFileSync(
    path.join(__dirname, "..", "..", "synap"),
    "utf8"
  );
  const hostRe = new RegExp(synap.match(/^_UE_RELEASE_RE='([^']+)'$/m)[1]);
  const trust = fs.readFileSync(path.join(__dirname, "trust.js"), "utf8");
  const agentRe = eval(
    trust.match(/^const DOCKER_TAG_PATTERN = (\/.+\/);$/m)[1]
  );
  assert.equal(
    agentRe.source,
    hostRe.source,
    "pod-agent DOCKER_TAG_PATTERN = synap _UE_RELEASE_RE"
  );
});

test("queue: a second order while one waits is BUSY and writes nothing", () => {
  const d = dirs();
  queueUpdateRequest({ ...d, commandId: "cmd-1", payload: ORDER });
  const before = fs.readFileSync(d.request, "utf8");
  assert.throws(
    () =>
      queueUpdateRequest({
        ...d,
        commandId: "cmd-2",
        payload: { ...ORDER, updateId: "upd-2" },
      }),
    (e) => e.code === "POD_AGENT_BUSY"
  );
  assert.equal(fs.readFileSync(d.request, "utf8"), before);
  // an operator's own request (no pending of ours) also blocks
  const e = dirs();
  fs.mkdirSync(path.dirname(e.request), { recursive: true });
  fs.writeFileSync(e.request, "{}");
  assert.throws(
    () => queueUpdateRequest({ ...e, commandId: "c", payload: ORDER }),
    (x) => x.code === "POD_AGENT_BUSY"
  );
  assert.equal(fs.existsSync(pendingFile(e.stateDir)), false);
});

test("queue: an invalid release is refused before anything is written", () => {
  const d = dirs();
  for (const targetVersion of ["latest", "v1;rm -rf /", "", undefined]) {
    assert.throws(() =>
      queueUpdateRequest({ ...d, commandId: "c", payload: { targetVersion } })
    );
  }
  assert.equal(fs.existsSync(d.request), false);
  assert.equal(fs.existsSync(pendingFile(d.stateDir)), false);
});

test("collect: nothing until the host records THIS request", () => {
  const d = dirs();
  assert.equal(collectUpdateOutcome(d), null, "no order, nothing to report");
  queueUpdateRequest({ ...d, commandId: "cmd-1", payload: ORDER });
  assert.equal(collectUpdateOutcome(d), null, "no record yet");
  record(d, "succeeded", { request: "someone-else" });
  assert.equal(
    collectUpdateOutcome(d),
    null,
    "another run's record is not ours"
  );
  record(d, "succeeded", { request: undefined });
  assert.equal(
    collectUpdateOutcome(d),
    null,
    "a person's run (no request) is not ours"
  );
});

test("collect: a unit-recorded outcome keeps its by:unit mark for the CP", () => {
  const d = dirs();
  queueUpdateRequest({ ...d, commandId: "cmd-1", payload: ORDER });
  record(d, "failed", { by: "unit" });
  const out = collectUpdateOutcome(d);
  assert.equal(out.result.code, "UPDATE_ENGINE_STOPPED");
  assert.equal(out.result.data.record.by, "unit");
  record(d, "rolled_back");
  assert.equal("by" in collectUpdateOutcome(d).result.data.record, false);
});

test("collect: each host outcome maps to its CP result; settle forgets the order", () => {
  const cases = [
    ["succeeded", { status: "completed", version: "main-abc1234" }],
    // Already on the ordered release: fulfilled, so success — not UPDATE_FAILED.
    ["noop", { status: "completed", version: "main-abc1234" }],
    ["rolled_back", { status: "rolled_back", code: "UPDATE_ROLLED_BACK" }],
    ["aborted", { status: "rolled_back", code: "UPDATE_NOT_APPLIED" }],
    ["rollback_failed", { status: "failed", code: "UPDATE_ROLLBACK_FAILED" }],
    // The unit's own record (request-outcome.sh): the engine never answered.
    ["failed", { status: "failed", code: "UPDATE_ENGINE_STOPPED" }],
    ["something-new", { status: "failed", code: "UPDATE_FAILED" }],
  ];
  for (const [hostStatus, want] of cases) {
    const d = dirs();
    queueUpdateRequest({ ...d, commandId: "cmd-1", payload: ORDER });
    record(d, hostStatus);
    const out = collectUpdateOutcome(d);
    assert.equal(out.commandId, "cmd-1", hostStatus);
    for (const [k, v] of Object.entries(want))
      assert.equal(out.result[k], v, `${hostStatus}.${k}`);
    assert.equal(out.result.data.record.status, hostStatus);
    assert.ok(fs.existsSync(pendingFile(d.stateDir)), "kept until settled");
    out.settle();
    assert.equal(fs.existsSync(pendingFile(d.stateDir)), false);
    assert.equal(collectUpdateOutcome(d), null);
  }
});

test("collect: a request no unit took in 15 min is taken back and failed", () => {
  const d = dirs();
  const t0 = Date.parse("2026-10-15T03:00:00Z");
  queueUpdateRequest({
    ...d,
    commandId: "cmd-1",
    payload: ORDER,
    now: new Date(t0),
  });
  assert.equal(collectUpdateOutcome({ ...d, now: t0 + 14 * 60_000 }), null);
  const out = collectUpdateOutcome({ ...d, now: t0 + 16 * 60_000 });
  assert.equal(out.result.code, "UPDATE_NOT_PICKED_UP");
  assert.equal(
    fs.existsSync(d.request),
    false,
    "a later unit cannot run the stale order"
  );
  assert.ok(
    fs.existsSync(path.join(path.dirname(d.request), "update.unclaimed.json"))
  );
});

test("collect: a taken request with no outcome in 3 h fails as NO_OUTCOME", () => {
  const d = dirs();
  const t0 = Date.parse("2026-10-15T03:00:00Z");
  queueUpdateRequest({
    ...d,
    commandId: "cmd-1",
    payload: ORDER,
    now: new Date(t0),
  });
  fs.renameSync(
    d.request,
    path.join(path.dirname(d.request), "update.taken.json")
  ); // the host took it
  assert.equal(
    collectUpdateOutcome({ ...d, now: t0 + 2 * 3600_000 }),
    null,
    "the engine may run 2 h"
  );
  assert.equal(
    collectUpdateOutcome({ ...d, now: t0 + 3 * 3600_000 + 1 }).result.code,
    "UPDATE_NO_OUTCOME"
  );
});

test("puller: queued on the order's tick, the outcome on a later one, retried until the CP has it", async () => {
  const d = dirs();
  const posts = [];
  let failNext = 0;
  const puller = createCommandPuller({
    cpUrl: "https://cp.example",
    signPodToken: (purpose, claims) => `${purpose}:${JSON.stringify(claims)}`,
    isEnrolled: () => true,
    verifyCommand: async () => ({
      type: "pod-command",
      commandId: "cmd-1",
      ...ORDER,
    }),
    consumeReceipt: () => "consumed",
    resolveCommand: () => "update",
    runCommand: async (_name, payload) =>
      queueUpdateRequest({ ...d, commandId: payload.commandId, payload }),
    collectOutcomes: () => {
      const o = collectUpdateOutcome(d);
      return o ? [o] : [];
    },
    request: async (method, url, { body } = {}) => {
      if (method === "GET") {
        const served =
          posts.length === 0 && !fs.existsSync(pendingFile(d.stateDir));
        return {
          status: 200,
          body: { commands: served ? [{ id: "cmd-1", token: "t" }] : [] },
        };
      }
      if (failNext > 0) {
        failNext--;
        return { status: 503, body: null };
      }
      posts.push({ url, body });
      return { status: 200, body: { received: true } };
    },
  });

  await (
    await puller.pollOnce()
  ).settled;
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/pods\/me\/commands\/cmd-1\/result$/);
  assert.equal(
    posts[0].body.status,
    "queued",
    "normalizeResult lets 'queued' through"
  );

  await (
    await puller.pollOnce()
  ).settled;
  assert.equal(posts.length, 1, "nothing to report while the host engine runs");

  record(d, "rolled_back");
  failNext = 1;
  await (
    await puller.pollOnce()
  ).settled;
  assert.equal(posts.length, 1, "a 503 is not delivery");
  assert.ok(
    fs.existsSync(pendingFile(d.stateDir)),
    "the order is kept on disk for the retry"
  );

  await (
    await puller.pollOnce()
  ).settled;
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.status, "rolled_back");
  assert.equal(posts[1].body.code, "UPDATE_ROLLED_BACK");
  assert.equal(
    fs.existsSync(pendingFile(d.stateDir)),
    false,
    "settled once the CP has it"
  );

  await (
    await puller.pollOnce()
  ).settled;
  assert.equal(posts.length, 2, "reported once");
});

// The image ships a hand list (Dockerfile COPY). Derive what server.js needs
// (local requires, transitively) and assert every one is copied.
test("the pod-agent image copies every module server.js loads", () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const m of src.matchAll(/require\("\.\/([\w-]+)"\)/g))
      visit(`${m[1]}.js`);
  };
  visit("server.js");
  assert.ok(
    seen.has("update-request.js") && seen.size >= 7,
    `scan saw ${[...seen]}`
  );
  const copy = fs
    .readFileSync(path.join(__dirname, "Dockerfile"), "utf8")
    .match(/^COPY (.+) \.\/$/m)[1]
    .split(/\s+/);
  for (const f of seen)
    assert.ok(copy.includes(f), `Dockerfile COPY is missing ${f}`);
});
