"use strict";

/**
 * Pull transport for Control Plane commands (SECURITY-PLAN-R1 §2, D2).
 *
 * The pod-agent asks the CP for its commands instead of exposing a public
 * route the CP pushes to. Two signatures on every command:
 *   - the POD proves who is asking: each request carries a pod-signed JWT
 *     (pod-identity.js, purpose `pod-commands.poll` / `pod-commands.result`),
 *     which the CP verifies through its one door `verifyPodJwt`;
 *   - the CP proves what is ordered: each command is a CP-signed JWT
 *     (type `pod-command`, aud = this pod, `commandId` = the queue row) that
 *     goes through the SAME verification as a pushed command (trust.js) plus
 *     the binding check below, and is consumed once (replay receipts).
 *
 * A pulled command never carries a callback URL: its result goes back to the
 * CP that served it, signed by the pod (`POST /pods/me/commands/:id/result`).
 * Nothing here runs a command itself — `runCommand` is the pod-agent's one
 * dispatcher (owner policy, payload validation, scripts), shared with push.
 */

const http = require("http");
const https = require("https");
const { POD_COMMAND_TYPE } = require("./trust");

const POD_COMMANDS_POLL_PURPOSE = "pod-commands.poll";
const POD_COMMANDS_RESULT_PURPOSE = "pod-commands.result";
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const RESULT_OUTPUT_MAX = 16_000;
const MAX_PENDING_RESULTS = 50;

function typedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * A pulled token must be a pod-command for exactly the queue row the CP
 * served it as — a token lifted from one row cannot report as another.
 */
function assertPulledCommandBinding(payload, commandId) {
  if (!payload || payload.type !== POD_COMMAND_TYPE) {
    throw typedError(
      "COMMAND_NOT_PULLABLE",
      "A pulled command must be a pod-command token"
    );
  }
  if (
    typeof payload.commandId !== "string" ||
    payload.commandId !== commandId
  ) {
    throw typedError(
      "COMMAND_ID_MISMATCH",
      "The command token names another queue entry"
    );
  }
}

/** Callback claims are a push-only legacy; a pulled command never follows them. */
function withoutCallbacks(payload) {
  const { callbackUrl: _url, callbackJwt: _jwt, ...rest } = payload;
  return rest;
}

/** The result body for a command that never ran (typed, no secret echoed). */
function refusalResult(error) {
  const code = (error && error.code) || "COMMAND_REJECTED";
  const policyCodes = new Set([
    "POD_POLICY_REFUSED",
    "ARCHIVE_RECIPIENT_MISSING",
  ]);
  return {
    status: policyCodes.has(code) ? "refused" : "failed",
    code,
    error: String((error && error.message) || "command rejected").slice(0, 500),
  };
}

function normalizeResult(result) {
  const status =
    result && ["completed", "failed", "refused"].includes(result.status)
      ? result.status
      : "failed";
  const out = { status };
  if (result && typeof result.code === "string") out.code = result.code;
  if (result && result.error) out.error = String(result.error).slice(0, 2000);
  if (result && typeof result.output === "string") {
    out.output = result.output.slice(0, RESULT_OUTPUT_MAX);
  }
  if (result && typeof result.version === "string")
    out.version = result.version;
  if (result && result.data !== undefined) out.data = result.data;
  return out;
}

/** JSON over http(s) with a bearer token; resolves {status, body}. */
function requestJson(method, url, { token, body, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === "https:" ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = mod.request(target, {
      method,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {}),
      },
    });
    req.on("response", (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end(payload || undefined);
  });
}

/**
 * @param cpUrl          the trusted issuer (POD_AGENT_ISSUER_URL) — the CP
 * @param signPodToken   (purpose, claims) => pod JWT (pod-identity.js)
 * @param isEnrolled     () => boolean — the CP holds this pod's key
 * @param verifyCommand  (token) => payload — CP signature + claims (trust.js)
 * @param consumeReceipt (payload) => "consumed" | "replayed"
 * @param resolveCommand (payload) => command name (trust.js)
 * @param runCommand     (name, payload) => Promise<result> — the dispatcher
 */
function createCommandPuller({
  cpUrl,
  signPodToken,
  isEnrolled,
  verifyCommand,
  consumeReceipt,
  resolveCommand,
  runCommand,
  request = requestJson,
  log = () => {},
}) {
  const base = String(cpUrl).replace(/\/+$/, "");
  const pendingResults = [];
  let timer = null;
  let polling = false;

  async function postResult(commandId, result) {
    const token = signPodToken(POD_COMMANDS_RESULT_PURPOSE, { commandId });
    const res = await request(
      "POST",
      `${base}/pods/me/commands/${encodeURIComponent(commandId)}/result`,
      { token, body: normalizeResult(result) }
    );
    // 409 = the CP already holds a result (or expired the row): never retry.
    if (res.status >= 500 || res.status === 429) {
      throw new Error(`result not accepted (HTTP ${res.status})`);
    }
    if (res.status >= 400) {
      log(`result for ${commandId} refused (HTTP ${res.status})`);
    }
  }

  async function report(commandId, result) {
    try {
      await postResult(commandId, result);
    } catch (error) {
      log(`result for ${commandId} deferred: ${error.message}`);
      if (pendingResults.length < MAX_PENDING_RESULTS) {
        pendingResults.push({ commandId, result });
      }
    }
  }

  async function flushPendingResults() {
    const queued = pendingResults.splice(0, pendingResults.length);
    for (const { commandId, result } of queued) await report(commandId, result);
  }

  async function handle(entry) {
    let result;
    try {
      const payload = await verifyCommand(entry.token);
      assertPulledCommandBinding(payload, entry.id);
      if (consumeReceipt(payload) === "replayed") {
        throw typedError("COMMAND_REPLAYED", "command token already used");
      }
      const name = resolveCommand(payload);
      log(`${name} pulled (${entry.id})`);
      result = await runCommand(name, withoutCallbacks(payload));
    } catch (error) {
      log(`pulled command ${entry.id} not run: ${error.message}`);
      result = refusalResult(error);
    }
    await report(entry.id, result);
    return result;
  }

  /**
   * One poll. Resolves once the CP answered; `settled` resolves when every
   * command claimed by this poll has run and reported.
   */
  async function pollOnce() {
    if (!isEnrolled())
      return { skipped: "not-enrolled", ids: [], settled: Promise.resolve([]) };
    await flushPendingResults();
    const token = signPodToken(POD_COMMANDS_POLL_PURPOSE, {});
    const res = await request("GET", `${base}/pods/me/commands`, { token });
    if (res.status !== 200 || !res.body || !Array.isArray(res.body.commands)) {
      const code = res.body && res.body.code ? ` ${res.body.code}` : "";
      throw new Error(`poll refused (HTTP ${res.status}${code})`);
    }
    const entries = res.body.commands.filter(
      (c) => c && typeof c.id === "string" && typeof c.token === "string"
    );
    return {
      ids: entries.map((e) => e.id),
      settled: Promise.all(entries.map(handle)),
    };
  }

  function start(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
    const tick = async () => {
      if (!polling) {
        polling = true;
        try {
          await pollOnce();
        } catch (error) {
          log(`poll failed: ${error.message}`);
        } finally {
          polling = false;
        }
      }
      timer = setTimeout(tick, intervalMs);
      if (timer.unref) timer.unref();
    };
    timer = setTimeout(tick, 1_000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { pollOnce, start, stop };
}

module.exports = {
  POD_COMMANDS_POLL_PURPOSE,
  POD_COMMANDS_RESULT_PURPOSE,
  assertPulledCommandBinding,
  createCommandPuller,
  refusalResult,
  requestJson,
  withoutCallbacks,
};
