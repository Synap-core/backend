#!/usr/bin/env node
/**
 * Pod Agent — Minimal command receiver for Synap pods.
 *
 * Stateless HTTP server that accepts issuer-signed JWT commands and dispatches
 * shell scripts via Docker socket. No database and zero npm dependencies.
 *
 * Trust is opt-in: POD_AGENT_ISSUER_URL and POD_AGENT_AUDIENCE are exact,
 * canonical HTTPS values set by the Pod owner. The request never supplies a
 * JWKS URL, issuer, or audience, so an external service cannot self-authorize.
 *
 * Transport (D2): the agent PULLS its commands from the issuer (pull.js),
 * authenticated by the pod's own key. The pushed routes below stay during the
 * transition behind POD_AGENT_PUSH_ENABLED. Either way every command passes
 * the owner's local policy (policy.js, D3) before it runs.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { archiveManifestFrom } = require("./archive-manifest");
const {
  assertPushable,
  commandErrorStatus,
  configureEnvEntries,
  createJwksKeyResolver,
  decodeCommandTokenHeader,
  isPushEnabled,
  parseImmutableEnvKeys,
  resolveCommandName,
  resolvePodAgentTrust,
  validateConfigurePayload,
  validateUpdateTargetVersion,
  verifyCommandToken,
} = require("./trust");
const { consumePodAgentReceipt } = require("./replay-receipts");
const {
  assertCommandAllowed,
  policyFile,
  readPodAgentPolicy,
} = require("./policy");
const {
  loadPodIdentity,
  podEnrollmentFile,
  podKeyFile,
  signPodJwt,
} = require("./pod-identity");
const { createCommandPuller } = require("./pull");
const {
  collectUpdateOutcome,
  queueUpdateRequest,
} = require("./update-request");

const PORT = parseInt(process.env.POD_AGENT_PORT || "4002", 10);
const DEPLOY_DIR = process.env.DEPLOY_DIR || "/deploy";
const POD_AGENT_STATE_DIR = process.env.POD_AGENT_STATE_DIR || "/state";
// D2: push (/api/pod-agent/command, host-log, docker-logs) is the transition
// transport. Commands are PULLED from the CP; the owner turns push off.
const PUSH_ENABLED = isPushEnabled();

// How much of a command's stdout/stderr we forward in the result packet.
// `logsSnippet` is intentionally bounded so an operational receiver can show
// useful failure context without accepting unbounded output.
const LOGS_SNIPPET_MAX = 16_000;
const FULL_OUTPUT_MAX = 50_000;

/**
 * Host log directory bind-mounted from /var/log on the host at /host-log:ro
 * inside this container. Used by the read-host-log endpoint to return the
 * contents of install / cloud-init log files to a trusted operator surface.
 *
 * The mount must be read-only; the allowlist below is the *only* way to read
 * files out of it, and no path traversal is permitted.
 */
const HOST_LOG_DIR = process.env.HOST_LOG_DIR || "/host-log";

/**
 * Files readable via GET /api/pod-agent/host-log?file=NAME. Strict allowlist
 * because this endpoint exposes host-visible state; anything not
 * explicitly listed here returns 404.
 */
const HOST_LOG_ALLOWLIST = new Set([
  "cp-callback.log", // legacy per-phase callback diagnostic filename
  "synap-install.log", // install.sh stdout
  "cloud-init-output.log", // full cloud-init runcmd output
  "cloud-init.log", // cloud-init internals
]);

const HOST_LOG_MAX_BYTES = 256 * 1024; // 256 KB — tail from end if larger

// ── Generic trust anchor ──
// The Pod agent deliberately has no default issuer. Its issuer and local
// audience are configured independently of any service implementation.
const POD_AGENT_TRUST = resolvePodAgentTrust();
const POD_AGENT_JWKS_URL = POD_AGENT_TRUST.configured
  ? POD_AGENT_TRUST.jwksUrl
  : "";

// ── JWKS Cache ──

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https://") ? https : http;
    const req = mod.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200)
        return reject(new Error(`JWKS ${res.statusCode}`));
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

// 24 h cache, refetched (rate-limited) on an unknown kid — see trust.js.
const getPublicKey = createJwksKeyResolver({
  fetchJson,
  createPublicKey: (jwk) => crypto.createPublicKey({ key: jwk, format: "jwk" }),
  onFetched: (jwksUrl) => log(`JWKS cached from ${jwksUrl}`),
});

// ── JWT Verification ──

async function verifyRequestToken(token) {
  if (!POD_AGENT_TRUST.configured) {
    throw new Error(
      POD_AGENT_TRUST.error || "pod-agent trust is not configured"
    );
  }
  const { kid } = decodeCommandTokenHeader(token);
  const publicKey = await getPublicKey(POD_AGENT_JWKS_URL, kid);
  return verifyCommandToken(token, publicKey, POD_AGENT_TRUST);
}

const activeOps = new Set();

function consumeSignedCommandReceipt(payload) {
  try {
    return consumePodAgentReceipt({
      directory: POD_AGENT_STATE_DIR,
      issuerUrl: POD_AGENT_TRUST.issuerUrl,
      jti: payload.jti,
      expiresAt: payload.exp * 1_000,
    });
  } catch (error) {
    const unavailable = new Error("pod-agent replay protection is unavailable");
    unavailable.cause = error;
    unavailable.code = "REPLAY_PROTECTION_UNAVAILABLE";
    throw unavailable;
  }
}

// ── Commands ──

// `update` is not here: the agent never runs it. A pulled update becomes a
// request for the host engine (update-request.js, decision 7).
const COMMANDS = {
  suspend: {
    script: "suspend-pod.sh",
    args: (p) => [p.callbackUrl || "", p.callbackJwt || ""],
  },
  restore: {
    script: "restore-pod.sh",
    args: (p) => [p.callbackUrl || "", p.callbackJwt || ""],
  },
  "restore-archive": {
    script: "restore-archive-pod.sh",
    args: (p) => [p.archiveUrl || "", p.callbackUrl || "", p.callbackJwt || ""],
  },
  archive: {
    script: "archive-pod.sh",
    args: (p) => [
      p.presignedUploadUrl || "",
      p.callbackUrl || "",
      p.callbackJwt || "",
    ],
  },
  configure: {
    script: "configure-pod.sh",
    args: (p) => {
      // The SAME entries validateConfigurePayload checked before dispatch.
      const envVars = configureEnvEntries(p);
      // Each flag + value must be a separate argv element so the shell sees
      // them as distinct positional parameters. Passing "--profile canary"
      // as a single string would make $1="--profile canary" and the
      // `--profile)` case wouldn't match.
      const profileArgs = (p.profiles || []).flatMap((pr) => [
        "--profile",
        String(pr),
      ]);
      const recreateArgs = (p.recreate || []).flatMap((svc) => [
        "--recreate",
        String(svc),
      ]);
      return [
        p.callbackUrl || "",
        p.callbackJwt || "",
        ...envVars,
        ...profileArgs,
        ...recreateArgs,
      ];
    },
  },
  "agent-update": {
    script: "update-agent.sh",
    args: (p) => [p.callbackUrl || "", p.callbackJwt || ""],
  },
};

/**
 * The `immutable` keys of this Pod's env.schema (the one schema env-config.sh
 * reads). Read per configure so a schema shipped by an update is honoured
 * without restarting the agent; an unreadable schema yields null and the
 * configure is refused (fail closed) by validateConfigurePayload.
 */
function readImmutableEnvKeys() {
  try {
    return parseImmutableEnvKeys(
      fs.readFileSync(path.join(DEPLOY_DIR, "env.schema"), "utf8")
    );
  } catch {
    return null;
  }
}

function validateCommandPayload(commandName, payload) {
  if (commandName === "update") {
    validateUpdateTargetVersion(payload);
    return;
  }
  if (commandName !== "configure") return;
  validateConfigurePayload(payload, readImmutableEnvKeys());
}

/**
 * Every check a command passes before it runs, for push and pull alike: the
 * owner's local policy (D3, archive recipients D15), then the payload.
 * Returns the policy the command runs under. Throws typed errors.
 */
function prepareCommand(commandName, payload) {
  const policy = readPodAgentPolicy(policyFile(DEPLOY_DIR));
  assertCommandAllowed(policy, commandName);
  validateCommandPayload(commandName, payload);
  return policy;
}

/**
 * Run a known, prepared command's script. Resolves (never rejects) with the
 * outcome; the caller has already claimed `activeOps` for it.
 */
function startCommand(commandName, payload, policy) {
  const cmd = COMMANDS[commandName];
  const env =
    commandName === "archive"
      ? {
          ...process.env,
          // D15: archive-pod.sh age-encrypts to exactly these recipients.
          ARCHIVE_AGE_RECIPIENTS: policy.archiveRecipients.join(" "),
        }
      : process.env;
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      [`${DEPLOY_DIR}/${cmd.script}`, ...cmd.args(payload)],
      { cwd: DEPLOY_DIR, timeout: cmd.timeout ?? 600_000, env },
      (err, stdout, stderr) => {
        activeOps.delete(commandName);
        const output = (stdout || "") + (stderr ? `\n[stderr] ${stderr}` : "");
        if (err)
          log(
            `${commandName} failed: ${err.message}\n${output.slice(0, 2000)}`
          );
        else log(`${commandName} done`);
        resolve({ status: err ? "failed" : "completed", output, err });
      }
    );
  });
}

/**
 * The tail of one allowlisted host log file — the read behind both the pushed
 * GET /host-log and a pulled `read-host-log` command.
 */
function readHostLog(fileParam) {
  if (!HOST_LOG_ALLOWLIST.has(fileParam)) {
    return {
      httpStatus: 404,
      body: {
        error: "file not in allowlist",
        allowlist: Array.from(HOST_LOG_ALLOWLIST),
      },
    };
  }

  // Resolve and re-verify the file stays inside HOST_LOG_DIR — defense in
  // depth against a malformed allowlist entry or symlink escape.
  const fullPath = path.resolve(HOST_LOG_DIR, fileParam);
  if (
    !fullPath.startsWith(HOST_LOG_DIR + path.sep) &&
    fullPath !== path.resolve(HOST_LOG_DIR)
  ) {
    return { httpStatus: 400, body: { error: "path escape" } };
  }

  let content;
  let size;
  let truncated = false;
  try {
    const stat = fs.statSync(fullPath);
    size = stat.size;
    if (size > HOST_LOG_MAX_BYTES) {
      const fd = fs.openSync(fullPath, "r");
      const buf = Buffer.alloc(HOST_LOG_MAX_BYTES);
      fs.readSync(fd, buf, 0, HOST_LOG_MAX_BYTES, size - HOST_LOG_MAX_BYTES);
      fs.closeSync(fd);
      content = buf.toString("utf8");
      truncated = true;
    } else {
      content = fs.readFileSync(fullPath, "utf8");
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        httpStatus: 200,
        body: { file: fileParam, exists: false, size: 0, content: "" },
      };
    }
    return { httpStatus: 500, body: { error: err.message || "read failed" } };
  }

  return {
    httpStatus: 200,
    body: { file: fileParam, exists: true, size, truncated, content },
  };
}

// ── HTTP Server ──

function log(msg) {
  console.log(`[${new Date().toISOString()}] [pod-agent] ${msg}`);
}

function respond(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function buildResultPacket(payload, commandName, status, err) {
  const errorSummary = err ? err.message : null;
  const base = {
    phase: "operation",
    step: "terminal",
    status,
    commandType: commandName,
    operationId: payload.updateId || payload.jti,
    correlationId: payload.correlationId || payload.nonce || payload.jti,
    errorSummary,
    logsSnippet: errorSummary,
    metadata: {
      targetVersion: payload.targetVersion || null,
      podAgent: "v1",
    },
  };
  return base;
}

http
  .createServer(async (req, res) => {
    if (
      req.method === "GET" &&
      (req.url === "/health" || req.url === "/api/pod-agent/health")
    ) {
      return respond(res, 200, {
        ok: true,
        agent: "pod-agent",
        uptime: Math.floor(process.uptime()),
      });
    }

    // Host log retrieval — authenticated GET. Returns the tail of a whitelisted
    // file from /host-log (bind-mounted read-only from the pod's /var/log).
    // The dashboard uses this for "Fetch cloud-init logs" in the Inspector so
    // admins don't need SSH for a routine debug.
    const hostLogMatch =
      req.method === "GET" &&
      (req.url || "").match(/^(?:\/api\/pod-agent)?\/host-log\?(.*)$/);
    if (hostLogMatch) {
      if (!PUSH_ENABLED) return respond(res, 404, { error: "not found" });
      try {
        const auth = req.headers["authorization"] || "";
        if (!auth.startsWith("Bearer "))
          return respond(res, 401, { error: "no auth" });
        if (!POD_AGENT_JWKS_URL)
          return respond(res, 503, {
            error: "pod-agent trust is not configured",
          });
        const payload = await verifyRequestToken(auth.slice(7));
        assertPushable(payload);
        if (resolveCommandName(payload) !== "read-host-log") {
          return respond(res, 403, { error: "wrong command" });
        }
        if (consumeSignedCommandReceipt(payload) === "replayed") {
          return respond(res, 409, { error: "replay" });
        }

        const params = new URLSearchParams(hostLogMatch[1]);
        const read = readHostLog(params.get("file") || "");
        return respond(res, read.httpStatus, read.body);
      } catch (e) {
        log(`host-log rejected: ${e.message}`);
        if (e.code === "REPLAY_PROTECTION_UNAVAILABLE") {
          return respond(res, 503, { error: e.message });
        }
        return respond(res, 403, { error: e.message });
      }
    }

    // Docker log streaming — SSE. GET /api/pod-agent/docker-logs?service=NAME
    // Streams `docker logs --follow --tail=200 synap-{service}` as Server-Sent Events.
    // JWT type must be "read-docker-logs". Service name is validated against an allowlist.
    const DOCKER_LOG_SERVICES = {
      api: "synap-backend",
      realtime: "synap-realtime",
      kratos: "synap-kratos",
      caddy: "synap-caddy",
      "pod-agent": "synap-pod-agent",
      typesense: "synap-typesense",
      postgres: "synap-postgres",
      redis: "synap-redis",
    };
    const dockerLogsMatch =
      req.method === "GET" &&
      (req.url || "").match(/^(?:\/api\/pod-agent)?\/docker-logs(?:\?(.*))?$/);
    if (dockerLogsMatch) {
      if (!PUSH_ENABLED) return respond(res, 404, { error: "not found" });
      try {
        const auth = req.headers["authorization"] || "";
        if (!auth.startsWith("Bearer "))
          return respond(res, 401, { error: "no auth" });
        if (!POD_AGENT_JWKS_URL)
          return respond(res, 503, {
            error: "pod-agent trust is not configured",
          });
        const payload = await verifyRequestToken(auth.slice(7));
        assertPushable(payload);
        if (resolveCommandName(payload) !== "read-docker-logs")
          return respond(res, 403, { error: "wrong command" });
        if (consumeSignedCommandReceipt(payload) === "replayed") {
          return respond(res, 409, { error: "replay" });
        }

        const params = new URLSearchParams(dockerLogsMatch[1] || "");
        const service = params.get("service") || "api";
        const tail = Math.min(
          parseInt(params.get("tail") || "200", 10) || 200,
          1000
        );
        const containerName = DOCKER_LOG_SERVICES[service];
        if (!containerName) {
          return respond(res, 400, {
            error: `unknown service: ${service}`,
            allowed: Object.keys(DOCKER_LOG_SERVICES),
          });
        }

        log(`docker-logs stream: ${service} (${containerName})`);

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });

        // Send a ready event so the client knows the stream opened
        res.write(
          `event: ready\ndata: ${JSON.stringify({ service, container: containerName })}\n\n`
        );

        const proc = spawn(
          "docker",
          ["logs", "--follow", `--tail=${tail}`, containerName],
          {
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

        function sendLine(line) {
          if (!line) return;
          res.write(
            `event: log\ndata: ${JSON.stringify({ line, t: Date.now() })}\n\n`
          );
        }

        let stdoutBuf = "";
        proc.stdout.on("data", (chunk) => {
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split("\n");
          stdoutBuf = lines.pop(); // keep partial line
          lines.forEach(sendLine);
        });

        let stderrBuf = "";
        proc.stderr.on("data", (chunk) => {
          stderrBuf += chunk.toString();
          const lines = stderrBuf.split("\n");
          stderrBuf = lines.pop();
          lines.forEach(sendLine);
        });

        proc.on("error", (err) => {
          log(`docker-logs proc error for ${containerName}: ${err.message}`);
          res.write(
            `event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`
          );
          res.end();
        });

        proc.on("close", (code) => {
          log(`docker-logs proc closed for ${containerName}: code=${code}`);
          res.write(`event: closed\ndata: ${JSON.stringify({ code })}\n\n`);
          res.end();
        });

        // Keepalive comment every 20s so proxies (Caddy, Cloudflare) don't close the stream
        const keepalive = setInterval(() => {
          try {
            res.write(": keepalive\n\n");
          } catch {
            clearInterval(keepalive);
          }
        }, 20_000);

        req.on("close", () => {
          clearInterval(keepalive);
          proc.kill("SIGTERM");
          log(`docker-logs client disconnected: ${service}`);
        });
      } catch (e) {
        log(`docker-logs rejected: ${e.message}`);
        if (e.code === "REPLAY_PROTECTION_UNAVAILABLE" && !res.headersSent) {
          return respond(res, 503, { error: e.message });
        }
        if (!res.headersSent) return respond(res, 403, { error: e.message });
        res.end();
      }
      return;
    }

    if (
      !PUSH_ENABLED ||
      req.method !== "POST" ||
      (req.url !== "/command" && req.url !== "/api/pod-agent/command")
    ) {
      return respond(res, 404, { error: "not found" });
    }

    try {
      const auth = req.headers["authorization"] || "";
      if (!auth.startsWith("Bearer "))
        return respond(res, 401, { error: "no auth" });
      if (!POD_AGENT_JWKS_URL)
        return respond(res, 503, {
          error: "pod-agent trust is not configured",
        });

      const payload = await verifyRequestToken(auth.slice(7));
      assertPushable(payload);
      const commandName = resolveCommandName(payload);
      const policy = prepareCommand(commandName, payload);
      // Its outcome can only reach the CP that served it (pull); a push has
      // nowhere to report it, so it is refused before the receipt is spent.
      if (commandName === "update")
        return respond(res, 412, {
          error: "update is pull-only: enroll this pod so its agent pulls",
          code: "POD_AGENT_PULL_REQUIRED",
        });

      if (consumeSignedCommandReceipt(payload) === "replayed")
        return respond(res, 409, { error: "replay" });
      if (!COMMANDS[commandName])
        return respond(res, 400, { error: `unknown command: ${commandName}` });

      if (activeOps.has(commandName))
        return respond(res, 429, { error: "busy" });

      activeOps.add(commandName);
      log(`${commandName} accepted`);

      startCommand(commandName, payload, policy).then(
        ({ status, output, err }) => {
          // Callback to the signed command's result receiver (Node.js https, not shell wget)
          if (payload.callbackUrl && payload.callbackJwt) {
            const packet = buildResultPacket(payload, commandName, status, err);
            const cbBody = JSON.stringify({
              updateId: payload.updateId,
              status,
              version: payload.targetVersion || commandName,
              error: err ? err.message : null,
              output: output.slice(0, FULL_OUTPUT_MAX),
              correlationId: packet.correlationId,
              step: packet.step,
              commandType: packet.commandType,
              errorSummary: packet.errorSummary,
              logsSnippet: output.slice(0, LOGS_SNIPPET_MAX),
              packet: {
                ...packet,
                logsSnippet: output.slice(0, LOGS_SNIPPET_MAX),
              },
            });
            const cbUrl = new URL(payload.callbackUrl);
            const cbReq = https.request(cbUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${payload.callbackJwt}`,
                "Content-Length": Buffer.byteLength(cbBody),
              },
              timeout: 10_000,
            });
            cbReq.on("response", (r) => log(`callback ${r.statusCode}`));
            cbReq.on("error", (e) => log(`callback error: ${e.message}`));
            cbReq.end(cbBody);
          }
        }
      );

      respond(res, 202, { accepted: true, command: commandName });
    } catch (e) {
      log(`rejected: ${e.message}`);
      respond(res, commandErrorStatus(e), {
        error: e.message,
        ...(e.code ? { code: e.code } : {}),
      });
    }
  })
  .listen(PORT, "0.0.0.0", () => log(`listening on ${PORT}`));

// ── Pull transport (D2) ──
//
// A pulled command runs through the SAME dispatcher as a pushed one; only the
// delivery differs. Its result goes back to the CP that served it.
async function runPulledCommand(commandName, payload) {
  if (commandName === "read-host-log") {
    assertCommandAllowed(
      readPodAgentPolicy(policyFile(DEPLOY_DIR)),
      commandName
    );
    const read = readHostLog(String(payload.file || ""));
    return read.httpStatus === 200
      ? { status: "completed", data: read.body }
      : {
          status: "failed",
          code: "HOST_LOG_UNREADABLE",
          error: read.body.error,
        };
  }
  const policy = prepareCommand(commandName, payload);
  if (commandName === "update") {
    try {
      return queueUpdateRequest({
        deployDir: DEPLOY_DIR,
        stateDir: POD_AGENT_STATE_DIR,
        commandId: payload.commandId,
        payload,
      });
    } catch (error) {
      if (error.code !== "POD_AGENT_BUSY") throw error;
      return { status: "failed", code: error.code, error: error.message };
    }
  }
  if (!COMMANDS[commandName]) {
    return {
      status: "failed",
      code: "UNKNOWN_COMMAND",
      error: `unknown command: ${commandName}`,
    };
  }
  if (activeOps.has(commandName)) {
    return { status: "failed", code: "POD_AGENT_BUSY", error: "busy" };
  }
  activeOps.add(commandName);
  log(`${commandName} accepted (pull)`);
  const { status, output, err } = await startCommand(
    commandName,
    payload,
    policy
  );
  const result = { status, output, ...(err ? { error: err.message } : {}) };
  if (commandName === "archive") {
    const archiveManifest = archiveManifestFrom(output);
    if (archiveManifest) result.data = { archiveManifest };
  }
  return result;
}

if (POD_AGENT_TRUST.configured) {
  const puller = createCommandPuller({
    cpUrl: POD_AGENT_TRUST.issuerUrl,
    // Re-read per token: a rotated key file is picked up without a restart.
    signPodToken: (purpose, claims) =>
      signPodJwt(
        loadPodIdentity(podKeyFile(DEPLOY_DIR)),
        {
          issuer: POD_AGENT_TRUST.audience,
          audience: POD_AGENT_TRUST.issuerUrl,
          purpose,
        },
        claims,
        60
      ),
    // Only once the CP holds this pod's key (`synap register` / `pod-key enroll`).
    isEnrolled: () => fs.existsSync(podEnrollmentFile(DEPLOY_DIR)),
    verifyCommand: verifyRequestToken,
    consumeReceipt: consumeSignedCommandReceipt,
    resolveCommand: resolveCommandName,
    runCommand: runPulledCommand,
    collectOutcomes: () => {
      const outcome = collectUpdateOutcome({
        deployDir: DEPLOY_DIR,
        stateDir: POD_AGENT_STATE_DIR,
      });
      return outcome ? [outcome] : [];
    },
    log,
  });
  puller.start();
  log(`pulling commands (push ${PUSH_ENABLED ? "enabled" : "disabled"})`);
}

process.on("SIGTERM", () => {
  log("shutting down");
  process.exit(0);
});
