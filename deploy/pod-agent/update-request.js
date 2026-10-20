"use strict";

/**
 * The pod-agent side of the ONE update engine (founder decision 7, W6-HEAL D2).
 *
 * pod-agent never runs an update. An `update` order that passed the owner's
 * policy and payload validation becomes a REQUEST file that the host's
 * `synap-update.path` unit watches. The contract is the REQUEST CONTRACT
 * comment above `_ue_unattended_plan` in `synap`. The command answers
 * "queued". The host engine records the outcome in state/last-update.json
 * with `request: <id>`, and collectUpdateOutcome reads it back on the puller's
 * tick so the terminal result reaches the CP.
 *
 * The order being waited on lives in the agent's state volume
 * (update-pending.json), so an agent restarted mid-update (the update itself
 * recreates the container) still reports it.
 */

const fs = require("fs");
const path = require("path");
const { validateUpdateTargetVersion } = require("./trust");

/** The host unit takes a request within seconds; 15 min means it is not installed. */
const PICKUP_TIMEOUT_MS = 15 * 60_000;
/** synap-update.service: TimeoutStartSec=90min + TimeoutStopSec=30min, plus margin. */
const OUTCOME_TIMEOUT_MS = 3 * 60 * 60_000;

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hostPaths(deployDir) {
  const requests = path.join(deployDir, "state", "requests");
  return {
    requests,
    request: path.join(requests, "update.json"),
    unclaimed: path.join(requests, "update.unclaimed.json"),
    lastUpdate: path.join(deployDir, "state", "last-update.json"),
  };
}

function pendingFile(stateDir) {
  return path.join(stateDir, "update-pending.json");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomically(file, value) {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Turn a validated `update` order into a request for the host engine.
 * Returns the "queued" result. Throws POD_AGENT_BUSY when an update is
 * already waiting, and the validator's typed error on a bad release id.
 */
function queueUpdateRequest({
  deployDir,
  stateDir,
  commandId,
  payload,
  now = new Date(),
}) {
  const release = validateUpdateTargetVersion(payload);
  const paths = hostPaths(deployDir);
  const pending = readJson(pendingFile(stateDir));
  if (pending) {
    throw typedError(
      "POD_AGENT_BUSY",
      `an update is already queued on this pod (request ${pending.requestId})`
    );
  }
  if (fs.existsSync(paths.request)) {
    throw typedError(
      "POD_AGENT_BUSY",
      "an update request is already waiting for the host engine"
    );
  }
  const requestId = String(payload.updateId || commandId || payload.jti).slice(
    0,
    128
  );
  const requestedAt = now.toISOString();
  // Pending first: if the agent dies before the request is written, the
  // outcome timeout still reports a failure instead of silence.
  fs.mkdirSync(stateDir, { recursive: true });
  writeAtomically(pendingFile(stateDir), {
    commandId,
    requestId,
    release,
    requestedAt,
  });
  fs.mkdirSync(paths.requests, { recursive: true });
  writeAtomically(paths.request, {
    schema: 1,
    release,
    requestedBy: "pod-agent",
    requestedAt,
    id: requestId,
  });
  return { status: "queued", version: release, data: { requestId } };
}

/** The CP result for one host outcome record (synap `_ue_record` statuses). */
function outcomeResult(record) {
  const reason = String(record.reason || "").slice(0, 2000);
  const data = {
    record: {
      status: record.status,
      from: record.from || null,
      to: record.to || null,
      reason: record.reason || null,
      dbRestored: record.dbRestored === true,
      ts: record.ts || null,
    },
  };
  switch (record.status) {
    case "succeeded":
    case "noop":
      // noop: the pod was already on the release it was asked for — the order
      // is fulfilled, nothing had to change.
      return { status: "completed", version: String(record.to || ""), data };
    case "rolled_back":
      return {
        status: "rolled_back",
        code: "UPDATE_ROLLED_BACK",
        error: reason,
        data,
      };
    case "aborted":
      // Stopped before anything changed: the pod still serves its release.
      return {
        status: "rolled_back",
        code: "UPDATE_NOT_APPLIED",
        error: reason,
        data,
      };
    case "rollback_failed":
      return {
        status: "failed",
        code: "UPDATE_ROLLBACK_FAILED",
        error: reason,
        data,
      };
    default:
      return {
        status: "failed",
        code: "UPDATE_FAILED",
        error: `unknown update outcome '${record.status}'`,
        data,
      };
  }
}

/**
 * The terminal result of the order this agent queued, once there is one.
 * Returns null while the host engine is still working. `settle()` forgets the
 * order; call it only once the CP has the result, so a failed post is re-read
 * on the next tick.
 */
function collectUpdateOutcome({
  deployDir,
  stateDir,
  now = Date.now(),
  pickupTimeoutMs = PICKUP_TIMEOUT_MS,
  outcomeTimeoutMs = OUTCOME_TIMEOUT_MS,
}) {
  const file = pendingFile(stateDir);
  const pending = readJson(file);
  if (!pending) return null;
  const settle = () => fs.rmSync(file, { force: true });
  if (typeof pending.commandId !== "string" || !pending.requestId) {
    settle(); // unreadable bookkeeping: nothing it could be reported against
    return null;
  }
  const paths = hostPaths(deployDir);
  const done = (result) => ({ commandId: pending.commandId, result, settle });

  const record = readJson(paths.lastUpdate);
  if (record && record.request === pending.requestId) {
    return done(outcomeResult(record));
  }

  const age = now - Date.parse(pending.requestedAt);
  if (fs.existsSync(paths.request) && age > pickupTimeoutMs) {
    try {
      // Take it back, so a unit installed later cannot run a stale order.
      fs.renameSync(paths.request, paths.unclaimed);
    } catch (error) {
      if (error.code === "ENOENT") return null; // the host took it just now
      throw error;
    }
    return done({
      status: "failed",
      code: "UPDATE_NOT_PICKED_UP",
      error:
        "the host update unit did not take the request within 15 min; nothing was changed. On the pod host run `synap units install`, then retry.",
    });
  }
  if (age > outcomeTimeoutMs) {
    return done({
      status: "failed",
      code: "UPDATE_NO_OUTCOME",
      error: `no outcome was recorded for request ${pending.requestId} within 3 h; see \`synap doctor\` and state/events.jsonl on the pod host.`,
    });
  }
  return null;
}

module.exports = {
  OUTCOME_TIMEOUT_MS,
  PICKUP_TIMEOUT_MS,
  collectUpdateOutcome,
  outcomeResult,
  pendingFile,
  queueUpdateRequest,
};
