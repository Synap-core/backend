#!/usr/bin/env node
/**
 * Pod Agent — Minimal command receiver for Synap pods.
 *
 * Listens on port 4002, accepts signed JWT commands from the Control Plane,
 * and dispatches shell scripts (update, suspend, restore, configure).
 *
 * Stateless: no database, no config file. Just JWT verification + Docker socket + shell exec.
 * JWKS URL is discovered from the request (X-JWKS-URL header), not from env vars.
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { execFile } = require("child_process");

const PORT = parseInt(process.env.POD_AGENT_PORT || "4002", 10);
const DEPLOY_DIR = process.env.DEPLOY_DIR || "/deploy";
const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── JWKS Cache ──────────────────────────────────────────────────────────────

const jwksCache = new Map(); // url -> { publicKeyPem, fetchedAt }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https://") ? https : http;
    const req = mod.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`JWKS fetch ${res.statusCode} from ${url}`));
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("JWKS fetch timeout")); });
  });
}

async function getPublicKeyPem(jwksUrl) {
  const cached = jwksCache.get(jwksUrl);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.publicKeyPem;
  }

  const body = await fetchJson(jwksUrl);
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`No keys in JWKS from ${jwksUrl}`);
  }

  const jwk = keys.find((k) => k.alg === "ES256" || k.kty === "EC") || keys[0];
  const publicKeyObj = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const publicKeyPem = publicKeyObj.export({ type: "spki", format: "pem" });

  jwksCache.set(jwksUrl, { publicKeyPem, fetchedAt: Date.now() });
  log(`JWKS cached from ${jwksUrl}`);
  return publicKeyPem;
}

// ── JWT Verification (manual, no npm deps) ──────────────────────────────────

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function verifyES256(token, publicKeyPem) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const header = JSON.parse(base64UrlDecode(parts[0]).toString());
  if (header.alg !== "ES256") throw new Error(`Unsupported alg: ${header.alg}`);

  const payload = JSON.parse(base64UrlDecode(parts[1]).toString());

  // Check expiry
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("JWT expired");
  }

  // Check issuer
  if (payload.iss !== "synap-control-plane") {
    throw new Error(`Unexpected issuer: ${payload.iss}`);
  }

  // Verify signature
  const signedData = parts[0] + "." + parts[1];
  const signature = base64UrlDecode(parts[2]);
  const verifier = crypto.createVerify("SHA256");
  verifier.update(signedData);

  if (!verifier.verify(publicKeyPem, signature)) {
    throw new Error("JWT signature invalid");
  }

  return payload;
}

// ── Nonce replay protection ─────────────────────────────────────────────────

const usedNonces = new Map(); // nonce -> timestamp

function checkNonce(nonce) {
  if (!nonce) return false;
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, Date.now());
  return true;
}

// Cleanup expired nonces every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [nonce, ts] of usedNonces) {
    if (ts < cutoff) usedNonces.delete(nonce);
  }
}, 5 * 60 * 1000);

// ── Rate limiting (one operation per type at a time) ────────────────────────

const activeOps = new Set();

// ── Command dispatch ────────────────────────────────────────────────────────

const COMMANDS = {
  update: { script: "update-pod.sh", argsFrom: (p) => [p.targetVersion || "latest", p.updateId || "", p.callbackUrl || "", p.callbackJwt || ""] },
  suspend: { script: "suspend-pod.sh", argsFrom: (p) => [p.callbackUrl || "", p.callbackJwt || ""] },
  restore: { script: "restore-pod.sh", argsFrom: (p) => [p.callbackUrl || "", p.callbackJwt || ""] },
  configure: { script: "configure-pod.sh", argsFrom: (p) => [p.callbackUrl || "", p.callbackJwt || "", ...(p.envVars || []), ...(p.profiles || [])] },
};

function dispatch(type, payload) {
  const cmd = COMMANDS[type];
  if (!cmd) {
    log(`Unknown command type: ${type}`);
    return;
  }

  if (activeOps.has(type)) {
    log(`Rate limited: ${type} already in progress`);
    return;
  }

  activeOps.add(type);
  const scriptPath = `${DEPLOY_DIR}/${cmd.script}`;
  const args = cmd.argsFrom(payload);

  log(`Dispatching ${type}: ${scriptPath} ${args.join(" ").substring(0, 80)}...`);

  execFile("/bin/sh", [scriptPath, ...args], { cwd: DEPLOY_DIR, timeout: 600_000 }, (err, stdout, stderr) => {
    activeOps.delete(type);
    if (err) {
      log(`Command ${type} failed: ${err.message}`);
      if (stderr) log(`stderr: ${stderr.substring(0, 500)}`);
    } else {
      log(`Command ${type} completed`);
    }
  });
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [pod-agent] ${msg}`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    return respond(res, 200, { ok: true, agent: "pod-agent", uptime: process.uptime() });
  }

  // Command endpoint — strip /api/pod-agent prefix if Caddy passes it through
  const isCommand =
    (req.method === "POST" && req.url === "/command") ||
    (req.method === "POST" && req.url === "/api/pod-agent/command");

  if (!isCommand) {
    return respond(res, 404, { error: "not found" });
  }

  try {
    // Extract JWT from Authorization header
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return respond(res, 401, { error: "missing authorization" });
    }
    const token = authHeader.slice(7);

    // Discover JWKS URL from header
    const jwksUrl = req.headers["x-jwks-url"];
    if (!jwksUrl) {
      return respond(res, 400, { error: "missing X-JWKS-URL header" });
    }

    // Security: only accept HTTPS JWKS URLs
    if (!jwksUrl.startsWith("https://")) {
      return respond(res, 400, { error: "JWKS URL must be HTTPS" });
    }

    // Fetch public key and verify JWT
    const publicKeyPem = await getPublicKeyPem(jwksUrl);
    const payload = verifyES256(token, publicKeyPem);

    // Nonce check
    if (!checkNonce(payload.nonce)) {
      return respond(res, 409, { error: "nonce already used or missing" });
    }

    // Rate limit check
    const cmdType = payload.type;
    if (!COMMANDS[cmdType]) {
      return respond(res, 400, { error: `unknown command type: ${cmdType}` });
    }

    if (activeOps.has(cmdType)) {
      return respond(res, 429, { error: `${cmdType} already in progress` });
    }

    log(`Accepted command: ${cmdType} from ${jwksUrl}`);
    dispatch(cmdType, payload);

    return respond(res, 202, { accepted: true, type: cmdType });
  } catch (err) {
    log(`Command rejected: ${err.message}`);
    return respond(res, 403, { error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  log(`Listening on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log("Shutting down...");
  server.close(() => process.exit(0));
});
