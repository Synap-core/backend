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
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const {
  normalizeHttpsUrl,
  resolveCommandName,
  resolvePodAgentTrust,
  validateSignedCommandClaims,
} = require("./trust");
const { consumePodAgentReceipt } = require("./replay-receipts");

const PORT = parseInt(process.env.POD_AGENT_PORT || "4002", 10);
const DEPLOY_DIR = process.env.DEPLOY_DIR || "/deploy";
const POD_AGENT_STATE_DIR = process.env.POD_AGENT_STATE_DIR || "/state";

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

const jwksCache = new Map(); // url -> { keys: Map<kid, KeyObject>, t }

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

function decodeJwtHeader(token) {
  const [encodedHeader] = token.split(".");
  if (!encodedHeader) throw new Error("malformed JWT");
  const header = JSON.parse(base64UrlDecode(encodedHeader));
  if (header.alg !== "ES256") throw new Error("unsupported alg");
  if (typeof header.kid !== "string" || header.kid.length === 0) {
    throw new Error("missing kid");
  }
  return header;
}

async function getPublicKey(jwksUrl, kid) {
  const cached = jwksCache.get(jwksUrl);
  let keys = cached && Date.now() - cached.t < 86_400_000 ? cached.keys : null;
  if (!keys) {
    const body = await fetchJson(jwksUrl);
    if (!Array.isArray(body.keys)) throw new Error("invalid JWKS");
    keys = new Map();
    for (const jwk of body.keys) {
      if (
        jwk &&
        typeof jwk.kid === "string" &&
        jwk.kid.length > 0 &&
        jwk.kty === "EC" &&
        jwk.alg === "ES256"
      ) {
        keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
      }
    }
    jwksCache.set(jwksUrl, { keys, t: Date.now() });
    log(`JWKS cached from ${jwksUrl}`);
  }

  const key = keys.get(kid);
  if (!key) throw new Error("unknown signing key");
  return key;
}

// ── JWT Verification ──

function base64UrlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyJWT(token, publicKey) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed JWT");
  decodeJwtHeader(token);
  const payload = JSON.parse(base64UrlDecode(p));
  // ES256 JWT uses raw R||S signature — dsaEncoding: "ieee-p1363"
  const ok = crypto.verify(
    "SHA256",
    Buffer.from(h + "." + p),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    base64UrlDecode(s)
  );
  if (!ok) throw new Error("bad signature");
  validateSignedCommandClaims(payload, POD_AGENT_TRUST);
  return payload;
}

async function verifyRequestToken(token) {
  if (!POD_AGENT_TRUST.configured) {
    throw new Error(
      POD_AGENT_TRUST.error || "pod-agent trust is not configured"
    );
  }
  const { kid } = decodeJwtHeader(token);
  const publicKey = await getPublicKey(POD_AGENT_JWKS_URL, kid);
  return verifyJWT(token, publicKey);
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

const COMMANDS = {
  update: {
    script: "update-pod.sh",
    args: (p) => [p.targetVersion || "latest"],
    // Canary (3 min) + production health (2 min) + image pull (variable).
    // On first pull of a multi-hundred-MB image this can exceed 10 min, causing
    // a false-failed callback even though the containers kept running. 25 min.
    timeout: 25 * 60 * 1000,
  },
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
      const envVars = Array.isArray(p.envVars)
        ? p.envVars
        : p.envVars && typeof p.envVars === "object"
          ? Object.entries(p.envVars).map(([k, v]) => `${k}=${String(v)}`)
          : [];
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
  exec: {
    script: null, // special case — exec directly via docker exec
    args: (p) => [p.container || "backend", p.command || "echo ok"],
  },
};

function configureEnvironment(payload) {
  const entries = Array.isArray(payload.envVars)
    ? payload.envVars
    : payload.envVars && typeof payload.envVars === "object"
      ? Object.entries(payload.envVars).map(
          ([key, value]) => `${key}=${String(value)}`
        )
      : [];
  const values = new Map();

  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error("invalid configure env var");
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error("invalid configure env var");
    values.set(entry.slice(0, separator), entry.slice(separator + 1));
  }

  return values;
}

function validateCommandPayload(commandName, payload) {
  if (commandName !== "configure") return;

  const environment = configureEnvironment(payload);
  if (environment.has("POD_AGENT_ISSUER_URL")) {
    throw new Error("POD_AGENT_ISSUER_URL cannot be changed by a command");
  }

  const nextAudience = environment.get("POD_AGENT_AUDIENCE");
  const nextPublicUrl = environment.get("PUBLIC_URL");
  if (nextAudience === undefined && nextPublicUrl === undefined) return;
  if (nextAudience === undefined || nextPublicUrl === undefined) {
    throw new Error("POD_AGENT_AUDIENCE and PUBLIC_URL must change together");
  }

  const normalizedAudience = normalizeHttpsUrl(nextAudience);
  const normalizedPublicUrl = normalizeHttpsUrl(nextPublicUrl);
  if (
    !normalizedAudience ||
    !normalizedPublicUrl ||
    normalizedAudience !== nextAudience ||
    normalizedPublicUrl !== nextPublicUrl ||
    normalizedAudience !== normalizedPublicUrl
  ) {
    throw new Error(
      "POD_AGENT_AUDIENCE must be the canonical PUBLIC_URL for this Pod"
    );
  }
}

// ── HTTP Server ──

function log(msg) {
  console.log(`[${new Date().toISOString()}] [pod-agent] ${msg}`);
}

function respond(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function buildResultPacket(payload, commandName, status, err, extra = {}) {
  const errorSummary = err ? err.message : null;
  const base = {
    phase: commandName === "update" ? "update" : "operation",
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
      ...extra,
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

    // Addon health check — lets an operator poll container readiness after provisioning.
    // Matches both /addon-health/:addon and /api/pod-agent/addon-health/:addon
    const addonHealthMatch =
      req.method === "GET" &&
      (req.url || "").match(
        /^(?:\/api\/pod-agent)?\/addon-health\/([a-zA-Z0-9_-]+)$/
      );
    if (addonHealthMatch) {
      const addonName = addonHealthMatch[1];
      // Try exact container name first, then synap-{addon} prefix (Docker Compose convention)
      const candidates = [addonName, `synap-${addonName}`];

      function checkCandidate(names, cb) {
        if (names.length === 0) return cb(null, null); // not found
        const name = names[0];
        execFile(
          "docker",
          [
            "inspect",
            `--format={{.State.Status}} {{.State.Health.Status}}`,
            name,
          ],
          { timeout: 10_000 },
          (err, stdout) => {
            if (err) return checkCandidate(names.slice(1), cb);
            cb(null, { name, output: (stdout || "").trim() });
          }
        );
      }

      checkCandidate(candidates, (err, result) => {
        if (err || !result) {
          // docker not available or unexpected error path
          const msg = err ? err.message : "container not found";
          log(`addon-health ${addonName}: ${msg}`);
          return respond(res, 200, {
            healthy: false,
            status: "stopped",
            addon: addonName,
          });
        }

        // output format: "<state> <healthStatus>" e.g. "running healthy", "running ", "exited "
        const parts = result.output.split(" ");
        const containerState = parts[0] || "";
        const healthStatus = parts[1] || "";

        let status;
        let healthy;

        if (containerState !== "running") {
          status = "stopped";
          healthy = false;
        } else if (healthStatus === "healthy") {
          status = "healthy";
          healthy = true;
        } else if (healthStatus === "starting") {
          status = "starting";
          healthy = false;
        } else {
          // running but no health check configured (healthStatus is empty or "")
          status = "running";
          healthy = true;
        }

        log(`addon-health ${addonName} (${result.name}): ${status}`);
        return respond(res, 200, { healthy, status, addon: addonName });
      });
      return; // response sent asynchronously
    }

    // Host log retrieval — authenticated GET. Returns the tail of a whitelisted
    // file from /host-log (bind-mounted read-only from the pod's /var/log).
    // The dashboard uses this for "Fetch cloud-init logs" in the Inspector so
    // admins don't need SSH for a routine debug.
    const hostLogMatch =
      req.method === "GET" &&
      (req.url || "").match(/^(?:\/api\/pod-agent)?\/host-log\?(.*)$/);
    if (hostLogMatch) {
      try {
        const auth = req.headers["authorization"] || "";
        if (!auth.startsWith("Bearer "))
          return respond(res, 401, { error: "no auth" });
        if (!POD_AGENT_JWKS_URL)
          return respond(res, 503, {
            error: "pod-agent trust is not configured",
          });
        const payload = await verifyRequestToken(auth.slice(7));
        if (resolveCommandName(payload) !== "read-host-log") {
          return respond(res, 403, { error: "wrong command" });
        }
        if (consumeSignedCommandReceipt(payload) === "replayed") {
          return respond(res, 409, { error: "replay" });
        }

        const params = new URLSearchParams(hostLogMatch[1]);
        const fileParam = params.get("file") || "";
        if (!HOST_LOG_ALLOWLIST.has(fileParam)) {
          return respond(res, 404, {
            error: "file not in allowlist",
            allowlist: Array.from(HOST_LOG_ALLOWLIST),
          });
        }

        // Resolve and re-verify the file stays inside HOST_LOG_DIR — defense in
        // depth against a malformed allowlist entry or symlink escape.
        const fullPath = path.resolve(HOST_LOG_DIR, fileParam);
        if (
          !fullPath.startsWith(HOST_LOG_DIR + path.sep) &&
          fullPath !== path.resolve(HOST_LOG_DIR)
        ) {
          return respond(res, 400, { error: "path escape" });
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
            fs.readSync(
              fd,
              buf,
              0,
              HOST_LOG_MAX_BYTES,
              size - HOST_LOG_MAX_BYTES
            );
            fs.closeSync(fd);
            content = buf.toString("utf8");
            truncated = true;
          } else {
            content = fs.readFileSync(fullPath, "utf8");
          }
        } catch (err) {
          if (err.code === "ENOENT") {
            return respond(res, 200, {
              file: fileParam,
              exists: false,
              size: 0,
              content: "",
            });
          }
          return respond(res, 500, { error: err.message || "read failed" });
        }

        return respond(res, 200, {
          file: fileParam,
          exists: true,
          size,
          truncated,
          content,
        });
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
      try {
        const auth = req.headers["authorization"] || "";
        if (!auth.startsWith("Bearer "))
          return respond(res, 401, { error: "no auth" });
        if (!POD_AGENT_JWKS_URL)
          return respond(res, 503, {
            error: "pod-agent trust is not configured",
          });
        const payload = await verifyRequestToken(auth.slice(7));
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
      const commandName = resolveCommandName(payload);
      validateCommandPayload(commandName, payload);

      if (consumeSignedCommandReceipt(payload) === "replayed")
        return respond(res, 409, { error: "replay" });
      if (!COMMANDS[commandName])
        return respond(res, 400, { error: `unknown command: ${commandName}` });

      // exec requires explicit allowExec claim in JWT
      if (commandName === "exec" && !payload.allowExec) {
        return respond(res, 403, { error: "exec requires allowExec claim" });
      }

      if (activeOps.has(commandName))
        return respond(res, 429, { error: "busy" });

      activeOps.add(commandName);
      const cmd = COMMANDS[commandName];
      log(`${commandName} accepted`);

      // exec: run docker exec and return output synchronously
      if (commandName === "exec") {
        const [container, command] = cmd.args(payload);
        execFile(
          "docker",
          ["exec", container, "sh", "-c", command],
          { timeout: 60_000 },
          (err, stdout, stderr) => {
            activeOps.delete(commandName);
            const output =
              (stdout || "") + (stderr ? `\n[stderr] ${stderr}` : "");
            if (err) log(`exec failed: ${err.message}`);
            else log(`exec done`);

            // Callback with output if callbackUrl is provided
            if (payload.callbackUrl && payload.callbackJwt) {
              const packet = buildResultPacket(
                payload,
                commandName,
                err ? "failed" : "completed",
                err,
                {
                  execContainer: container,
                }
              );
              const body = JSON.stringify({
                type: "exec",
                success: !err,
                output: output.slice(0, FULL_OUTPUT_MAX),
                error: err ? err.message : null,
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
              const cbReq = https.request(payload.callbackUrl, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${payload.callbackJwt}`,
                  "Content-Length": Buffer.byteLength(body),
                },
                timeout: 10_000,
              });
              cbReq.on("error", (e) =>
                log(`exec callback failed: ${e.message}`)
              );
              cbReq.end(body);
            }
          }
        );

        return respond(res, 202, { accepted: true, command: commandName });
      }

      execFile(
        "/bin/sh",
        [`${DEPLOY_DIR}/${cmd.script}`, ...cmd.args(payload)],
        { cwd: DEPLOY_DIR, timeout: cmd.timeout ?? 600_000 },
        (err, stdout, stderr) => {
          activeOps.delete(commandName);
          const status = err ? "failed" : "completed";
          const output =
            (stdout || "") + (stderr ? `\n[stderr] ${stderr}` : "");
          if (err)
            log(
              `${commandName} failed: ${err.message}\n${output.slice(0, 2000)}`
            );
          else log(`${commandName} done`);

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
      respond(res, e.code === "REPLAY_PROTECTION_UNAVAILABLE" ? 503 : 403, {
        error: e.message,
      });
    }
  })
  .listen(PORT, "0.0.0.0", () => log(`listening on ${PORT}`));

process.on("SIGTERM", () => {
  log("shutting down");
  process.exit(0);
});
