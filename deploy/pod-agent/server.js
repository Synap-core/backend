#!/usr/bin/env node
/**
 * Pod Agent — Minimal command receiver for Synap pods.
 *
 * Stateless HTTP server that accepts CP-signed JWT commands and dispatches
 * shell scripts via Docker socket. No config, no database, zero npm deps.
 *
 * JWKS URL is pinned to CONTROL_PLANE_URL env var (set by install.sh).
 * The X-JWKS-URL request header is ignored — callers cannot substitute keys.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = parseInt(process.env.POD_AGENT_PORT || "4002", 10);
const DEPLOY_DIR = process.env.DEPLOY_DIR || "/deploy";

/**
 * Host log directory bind-mounted from /var/log on the host at /host-log:ro
 * inside this container. Used by the read-host-log endpoint to return the
 * contents of install / cloud-init log files to the Control Plane dashboard.
 *
 * The mount must be read-only; the allowlist below is the *only* way to read
 * files out of it, and no path traversal is permitted.
 */
const HOST_LOG_DIR = process.env.HOST_LOG_DIR || "/host-log";

/**
 * Files readable via GET /api/pod-agent/host-log?file=NAME. Strict allowlist
 * because this endpoint exposes host-visible state to the CP; anything not
 * explicitly listed here returns 404.
 */
const HOST_LOG_ALLOWLIST = new Set([
  "cp-callback.log",       // per-phase install-callback outcomes
  "synap-install.log",      // install.sh stdout
  "cloud-init-output.log",  // full cloud-init runcmd output
  "cloud-init.log",         // cloud-init internals
]);

const HOST_LOG_MAX_BYTES = 256 * 1024; // 256 KB — tail from end if larger

// ── CP trust anchor ──
// CONTROL_PLANE_URL is set by install.sh and injected into this container
// via docker-compose. Pod-agent pins its JWKS endpoint to this URL and will
// NOT accept a JWKS URL from the request header — eliminating the ability for
// any caller to substitute their own signing key.
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || "";
const CP_JWKS_URL = CONTROL_PLANE_URL ? `${CONTROL_PLANE_URL}/.well-known/jwks.json` : "";

// ── JWKS Cache ──

const jwksCache = new Map(); // url -> { key, t }

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

async function getPublicKey(jwksUrl) {
  const cached = jwksCache.get(jwksUrl);
  if (cached && Date.now() - cached.t < 86400000) return cached.key;
  const body = await fetchJson(jwksUrl);
  const jwk =
    (body.keys || []).find((k) => k.alg === "ES256" || k.kty === "EC") ||
    body.keys[0];
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  jwksCache.set(jwksUrl, { key, t: Date.now() });
  log(`JWKS cached from ${jwksUrl}`);
  return key;
}

// ── JWT Verification ──

function base64UrlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyJWT(token, publicKey) {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed JWT");
  const header = JSON.parse(base64UrlDecode(h));
  if (header.alg !== "ES256") throw new Error("unsupported alg");
  const payload = JSON.parse(base64UrlDecode(p));
  if (payload.exp && payload.exp < Date.now() / 1000) throw new Error("expired");
  if (payload.iss !== "synap-control-plane") throw new Error("bad issuer");
  // ES256 JWT uses raw R||S signature — dsaEncoding: "ieee-p1363"
  const ok = crypto.verify(
    "SHA256",
    Buffer.from(h + "." + p),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    base64UrlDecode(s)
  );
  if (!ok) throw new Error("bad signature");
  return payload;
}

// ── Nonce + Rate Limiting ──

const usedNonces = new Map();
const activeOps = new Set();

setInterval(() => {
  const cutoff = Date.now() - 600000;
  for (const [k, v] of usedNonces) if (v < cutoff) usedNonces.delete(k);
}, 300000);

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
    args: (p) => [p.presignedUploadUrl || "", p.callbackUrl || "", p.callbackJwt || ""],
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
      const profileArgs = (p.profiles || []).flatMap((pr) => ["--profile", String(pr)]);
      const recreateArgs = (p.recreate || []).flatMap((svc) => ["--recreate", String(svc)]);
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

// ── HTTP Server ──

function log(msg) {
  console.log(`[${new Date().toISOString()}] [pod-agent] ${msg}`);
}

function respond(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function buildResultPacket(payload, status, err, extra = {}) {
  const errorSummary = err ? err.message : null;
  const base = {
    phase: payload.type === "update" ? "update" : "operation",
    step: "terminal",
    status,
    commandType: payload.type,
    operationId: payload.updateId || payload.nonce || null,
    correlationId: payload.correlationId || payload.nonce || null,
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
    if (req.method === "GET" && (req.url === "/health" || req.url === "/api/pod-agent/health")) {
      return respond(res, 200, { ok: true, agent: "pod-agent", uptime: Math.floor(process.uptime()) });
    }

    // Addon health check — used by CP to poll container readiness after provisioning
    // Matches both /addon-health/:addon and /api/pod-agent/addon-health/:addon
    const addonHealthMatch =
      req.method === "GET" &&
      (req.url || "").match(/^(?:\/api\/pod-agent)?\/addon-health\/([a-zA-Z0-9_-]+)$/);
    if (addonHealthMatch) {
      const addonName = addonHealthMatch[1];
      // Try exact container name first, then synap-{addon} prefix (Docker Compose convention)
      const candidates = [addonName, `synap-${addonName}`];

      function checkCandidate(names, cb) {
        if (names.length === 0) return cb(null, null); // not found
        const name = names[0];
        execFile(
          "docker",
          ["inspect", `--format={{.State.Status}} {{.State.Health.Status}}`, name],
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
          return respond(res, 200, { healthy: false, status: "stopped", addon: addonName });
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
        if (!auth.startsWith("Bearer ")) return respond(res, 401, { error: "no auth" });
        if (!CP_JWKS_URL) return respond(res, 503, { error: "CONTROL_PLANE_URL not configured on this pod" });
        const publicKey = await getPublicKey(CP_JWKS_URL);
        const payload = verifyJWT(auth.slice(7), publicKey);
        if (payload.type !== "read-host-log") {
          return respond(res, 403, { error: "wrong jwt type" });
        }

        const params = new URLSearchParams(hostLogMatch[1]);
        const fileParam = params.get("file") || "";
        if (!HOST_LOG_ALLOWLIST.has(fileParam)) {
          return respond(res, 404, { error: "file not in allowlist", allowlist: Array.from(HOST_LOG_ALLOWLIST) });
        }

        // Resolve and re-verify the file stays inside HOST_LOG_DIR — defense in
        // depth against a malformed allowlist entry or symlink escape.
        const fullPath = path.resolve(HOST_LOG_DIR, fileParam);
        if (!fullPath.startsWith(HOST_LOG_DIR + path.sep) && fullPath !== path.resolve(HOST_LOG_DIR)) {
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
            fs.readSync(fd, buf, 0, HOST_LOG_MAX_BYTES, size - HOST_LOG_MAX_BYTES);
            fs.closeSync(fd);
            content = buf.toString("utf8");
            truncated = true;
          } else {
            content = fs.readFileSync(fullPath, "utf8");
          }
        } catch (err) {
          if (err.code === "ENOENT") {
            return respond(res, 200, { file: fileParam, exists: false, size: 0, content: "" });
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
        return respond(res, 403, { error: e.message });
      }
    }

    if (req.method !== "POST" || (req.url !== "/command" && req.url !== "/api/pod-agent/command")) {
      return respond(res, 404, { error: "not found" });
    }

    try {
      const auth = req.headers["authorization"] || "";
      if (!auth.startsWith("Bearer ")) return respond(res, 401, { error: "no auth" });
      if (!CP_JWKS_URL) return respond(res, 503, { error: "CONTROL_PLANE_URL not configured on this pod" });

      const publicKey = await getPublicKey(CP_JWKS_URL);
      const payload = verifyJWT(auth.slice(7), publicKey);

      if (payload.nonce) {
        if (usedNonces.has(payload.nonce)) return respond(res, 409, { error: "replay" });
        usedNonces.set(payload.nonce, Date.now());
      }
      if (!COMMANDS[payload.type]) return respond(res, 400, { error: `unknown type: ${payload.type}` });

      // exec requires explicit allowExec claim in JWT
      if (payload.type === "exec" && !payload.allowExec) {
        return respond(res, 403, { error: "exec requires allowExec claim" });
      }

      if (activeOps.has(payload.type)) return respond(res, 429, { error: "busy" });

      activeOps.add(payload.type);
      const cmd = COMMANDS[payload.type];
      log(`${payload.type} accepted`);

      // exec: run docker exec and return output synchronously
      if (payload.type === "exec") {
        const [container, command] = cmd.args(payload);
        execFile("docker", ["exec", container, "sh", "-c", command], { timeout: 60_000 }, (err, stdout, stderr) => {
          activeOps.delete(payload.type);
          const output = (stdout || "") + (stderr ? `\n[stderr] ${stderr}` : "");
          if (err) log(`exec failed: ${err.message}`);
          else log(`exec done`);

          // Callback with output if callbackUrl is provided
          if (payload.callbackUrl && payload.callbackJwt) {
            const packet = buildResultPacket(payload, err ? "failed" : "completed", err, {
              execContainer: container,
            });
            const body = JSON.stringify({
              type: "exec",
              success: !err,
              output: output.slice(0, 50_000),
              error: err ? err.message : null,
              correlationId: packet.correlationId,
              step: packet.step,
              commandType: packet.commandType,
              errorSummary: packet.errorSummary,
              logsSnippet: output.slice(0, 2000),
              packet: { ...packet, logsSnippet: output.slice(0, 2000) },
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
            cbReq.on("error", (e) => log(`exec callback failed: ${e.message}`));
            cbReq.end(body);
          }
        });

        return respond(res, 202, { accepted: true, type: "exec" });
      }

      execFile("/bin/sh", [`${DEPLOY_DIR}/${cmd.script}`, ...cmd.args(payload)], { cwd: DEPLOY_DIR, timeout: cmd.timeout ?? 600_000 }, (err, stdout, stderr) => {
        activeOps.delete(payload.type);
        const status = err ? "failed" : "completed";
        const output = (stdout || "") + (stderr ? `\n[stderr] ${stderr}` : "");
        if (err) log(`${payload.type} failed: ${err.message}\n${output.slice(0, 2000)}`);
        else log(`${payload.type} done`);

        // Callback to CP with result (Node.js https, not shell wget)
        if (payload.callbackUrl && payload.callbackJwt) {
          const packet = buildResultPacket(payload, status, err);
          const cbBody = JSON.stringify({
            updateId: payload.updateId,
            status,
            version: payload.targetVersion || payload.type,
            error: err ? err.message : null,
            output: output.slice(0, 50_000),
            correlationId: packet.correlationId,
            step: packet.step,
            commandType: packet.commandType,
            errorSummary: packet.errorSummary,
            logsSnippet: output.slice(0, 2000),
            packet: { ...packet, logsSnippet: output.slice(0, 2000) },
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
      });

      respond(res, 202, { accepted: true, type: payload.type });
    } catch (e) {
      log(`rejected: ${e.message}`);
      respond(res, 403, { error: e.message });
    }
  })
  .listen(PORT, "0.0.0.0", () => log(`listening on ${PORT}`));

process.on("SIGTERM", () => {
  log("shutting down");
  process.exit(0);
});
