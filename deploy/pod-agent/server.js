#!/usr/bin/env node
/**
 * Pod Agent — Minimal command receiver for Synap pods.
 *
 * Stateless HTTP server that accepts CP-signed JWT commands and dispatches
 * shell scripts via Docker socket. No config, no database, zero npm deps.
 *
 * JWKS URL discovered from request header — pod needs no CP configuration.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PORT = parseInt(process.env.POD_AGENT_PORT || "4002", 10);
const DEPLOY_DIR = process.env.DEPLOY_DIR || "/deploy";

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
    args: (p) => [p.callbackUrl || "", p.callbackJwt || "", ...(p.envVars || []), ...(p.profiles || []).map((pr) => `--profile ${pr}`)],
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

http
  .createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/api/pod-agent/health")) {
      return respond(res, 200, { ok: true, agent: "pod-agent", uptime: Math.floor(process.uptime()) });
    }

    if (req.method !== "POST" || (req.url !== "/command" && req.url !== "/api/pod-agent/command")) {
      return respond(res, 404, { error: "not found" });
    }

    try {
      const auth = req.headers["authorization"] || "";
      if (!auth.startsWith("Bearer ")) return respond(res, 401, { error: "no auth" });
      const jwksUrl = req.headers["x-jwks-url"];
      if (!jwksUrl || !jwksUrl.startsWith("https://")) return respond(res, 400, { error: "bad jwks url" });

      const publicKey = await getPublicKey(jwksUrl);
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
            const body = JSON.stringify({
              type: "exec",
              success: !err,
              output: output.slice(0, 50_000),
              error: err ? err.message : null,
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

      execFile("/bin/sh", [`${DEPLOY_DIR}/${cmd.script}`, ...cmd.args(payload)], { cwd: DEPLOY_DIR, timeout: 600_000 }, (err) => {
        activeOps.delete(payload.type);
        const status = err ? "failed" : "completed";
        if (err) log(`${payload.type} failed: ${err.message}`);
        else log(`${payload.type} done`);

        // Callback to CP with result (Node.js https, not shell wget)
        if (payload.callbackUrl && payload.callbackJwt) {
          const cbBody = JSON.stringify({
            updateId: payload.updateId,
            status,
            version: payload.targetVersion || payload.type,
            error: err ? err.message : null,
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
