"use strict";

// D2 pull transport against a stub Control Plane on 127.0.0.1. Everything on
// the pod side is the REAL code path: pod-identity.js signs, trust.js
// verifies the CP's command tokens, replay-receipts.js consumes them,
// policy.js decides. Only the script runner is a stub (no process launched).
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createCommandPuller } = require("./pull");
const { loadPodIdentity, signPodJwt } = require("./pod-identity");
const { consumePodAgentReceipt } = require("./replay-receipts");
const { assertCommandAllowed, readPodAgentPolicy } = require("./policy");
const { resolveCommandName, verifyCommandToken } = require("./trust");

const POD_ORIGIN = "https://pod.example.com";

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function es256(header, payload, privateKey) {
  const input = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.sign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${sig.toString("base64url")}`;
}

function verifyEs256(token, publicKey) {
  const [h, p, s] = token.split(".");
  return crypto.verify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url")
  );
}

/** A stub CP: serves queued command tokens, records results. */
async function startStubCp(podPublicKey) {
  const state = { queue: [], results: [], requests: [], failResults: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const token = (req.headers.authorization || "").replace(/^Bearer /, "");
      const claims = JSON.parse(
        Buffer.from(token.split(".")[1] || "", "base64url").toString() || "{}"
      );
      const header = JSON.parse(
        Buffer.from(token.split(".")[0] || "", "base64url").toString() || "{}"
      );
      state.requests.push({ method: req.method, url: req.url, claims, header });
      if (!verifyEs256(token, podPublicKey)) {
        res.writeHead(401).end(JSON.stringify({ code: "POD_JWT_SIGNATURE" }));
        return;
      }
      if (req.method === "GET" && req.url === "/pods/me/commands") {
        const commands = state.queue.splice(0, state.queue.length);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ commands }));
        return;
      }
      const m = /^\/pods\/me\/commands\/([^/]+)\/result$/.exec(req.url);
      if (req.method === "POST" && m) {
        if (state.failResults > 0) {
          state.failResults -= 1;
          res.writeHead(503).end("{}");
          return;
        }
        state.results.push({ id: m[1], claims, body: JSON.parse(body) });
        res.writeHead(200).end("{}");
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { state, url, close: () => new Promise((r) => server.close(r)) };
}

function setup({ policy, enrolled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pod-agent-pull-"));
  const pod = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const keyFile = path.join(dir, "pod-key.pem");
  fs.writeFileSync(
    keyFile,
    pod.privateKey.export({ format: "pem", type: "pkcs8" })
  );
  const policyFile = path.join(dir, "pod-agent-policy.json");
  if (policy) fs.writeFileSync(policyFile, JSON.stringify(policy));
  const cp = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { dir, pod, keyFile, policyFile, cp, enrolled };
}

function makePuller(env, cpUrl, ran) {
  const trust = {
    configured: true,
    issuerUrl: cpUrl,
    audience: POD_ORIGIN,
  };
  return createCommandPuller({
    cpUrl,
    signPodToken: (purpose, claims) =>
      signPodJwt(
        loadPodIdentity(env.keyFile),
        { issuer: POD_ORIGIN, audience: cpUrl, purpose },
        claims,
        60
      ),
    isEnrolled: () => env.enrolled,
    verifyCommand: async (token) =>
      verifyCommandToken(token, env.cp.publicKey, trust),
    consumeReceipt: (payload) =>
      consumePodAgentReceipt({
        directory: path.join(env.dir, "receipts"),
        issuerUrl: cpUrl,
        jti: payload.jti,
        expiresAt: payload.exp * 1000,
      }),
    resolveCommand: resolveCommandName,
    runCommand: async (name, payload) => {
      assertCommandAllowed(readPodAgentPolicy(env.policyFile), name);
      ran.push({ name, payload });
      return { status: "completed", output: `${name} ok` };
    },
  });
}

function commandToken(env, cpUrl, claims, signer = env.cp.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return es256(
    { alg: "ES256", kid: "cp-test-kid" },
    {
      iss: cpUrl,
      aud: POD_ORIGIN,
      type: "pod-command",
      iat: now,
      exp: now + 600,
      jti: crypto.randomUUID(),
      ...claims,
    },
    signer
  );
}

async function pollAndSettle(puller) {
  const { ids, settled } = await puller.pollOnce();
  await settled;
  return ids;
}

test("polls with a pod JWT, runs a verified command, posts a pod-signed result", async (t) => {
  const env = setup({ policy: { mode: "managed" } });
  const cp = await startStubCp(env.pod.publicKey);
  t.after(cp.close);
  const ran = [];
  const puller = makePuller(env, cp.url, ran);
  cp.state.queue.push({
    id: "cmd-1",
    token: commandToken(env, cp.url, {
      command: "configure",
      commandId: "cmd-1",
      envVars: ["FOO=bar"],
      callbackUrl: "https://evil.example/collect",
      callbackJwt: "x",
    }),
  });

  assert.deepEqual(await pollAndSettle(puller), ["cmd-1"]);

  const [poll] = cp.state.requests;
  assert.equal(poll.header.typ, "pod+jwt");
  assert.equal(poll.claims.purpose, "pod-commands.poll");
  assert.equal(poll.claims.iss, POD_ORIGIN);
  assert.equal(poll.claims.aud, cp.url);

  assert.equal(ran.length, 1);
  assert.equal(ran[0].name, "configure");
  // A pulled command never follows a callback URL.
  assert.equal("callbackUrl" in ran[0].payload, false);
  assert.equal("callbackJwt" in ran[0].payload, false);

  assert.equal(cp.state.results.length, 1);
  const [result] = cp.state.results;
  assert.equal(result.id, "cmd-1");
  assert.equal(result.claims.purpose, "pod-commands.result");
  assert.equal(result.claims.commandId, "cmd-1");
  assert.deepEqual(result.body, {
    status: "completed",
    output: "configure ok",
  });
});

test("D3: a self-hosted pod (no policy file) refuses archive — typed, never run", async (t) => {
  const env = setup();
  const cp = await startStubCp(env.pod.publicKey);
  t.after(cp.close);
  const ran = [];
  cp.state.queue.push({
    id: "cmd-2",
    token: commandToken(env, cp.url, {
      command: "archive",
      commandId: "cmd-2",
    }),
  });
  await pollAndSettle(makePuller(env, cp.url, ran));
  assert.equal(ran.length, 0);
  assert.equal(cp.state.results[0].body.status, "refused");
  assert.equal(cp.state.results[0].body.code, "POD_POLICY_REFUSED");
});

test("a token naming another queue entry, or a pushed-style token, is refused unrun", async (t) => {
  const env = setup({ policy: { mode: "managed" } });
  const cp = await startStubCp(env.pod.publicKey);
  t.after(cp.close);
  const ran = [];
  cp.state.queue.push(
    {
      id: "cmd-3",
      token: commandToken(env, cp.url, {
        command: "update",
        commandId: "cmd-9",
      }),
    },
    {
      id: "cmd-4",
      token: commandToken(env, cp.url, {
        type: "update",
        command: "update",
        commandId: "cmd-4",
      }),
    }
  );
  await pollAndSettle(makePuller(env, cp.url, ran));
  assert.equal(ran.length, 0);
  const codes = Object.fromEntries(
    cp.state.results.map((r) => [r.id, r.body.code])
  );
  assert.deepEqual(codes, {
    "cmd-3": "COMMAND_ID_MISMATCH",
    "cmd-4": "COMMAND_NOT_PULLABLE",
  });
});

test("a command not signed by the trusted CP key is refused unrun", async (t) => {
  const env = setup({ policy: { mode: "managed" } });
  const cp = await startStubCp(env.pod.publicKey);
  t.after(cp.close);
  const ran = [];
  const forger = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  cp.state.queue.push({
    id: "cmd-5",
    token: commandToken(
      env,
      cp.url,
      { command: "update", commandId: "cmd-5" },
      forger.privateKey
    ),
  });
  await pollAndSettle(makePuller(env, cp.url, ran));
  assert.equal(ran.length, 0);
  assert.equal(cp.state.results[0].body.status, "failed");
  assert.match(cp.state.results[0].body.error, /bad signature/);
});

test("a claimed token served twice runs once (durable receipt)", async (t) => {
  const env = setup({ policy: { mode: "managed" } });
  const cp = await startStubCp(env.pod.publicKey);
  t.after(cp.close);
  const ran = [];
  const puller = makePuller(env, cp.url, ran);
  const token = commandToken(env, cp.url, {
    command: "update",
    commandId: "c6",
  });
  cp.state.queue.push({ id: "c6", token });
  await pollAndSettle(puller);
  cp.state.queue.push({ id: "c6", token });
  await pollAndSettle(puller);
  assert.equal(ran.length, 1);
  assert.equal(cp.state.results[1].body.code, "COMMAND_REPLAYED");
});

test("not enrolled: the agent does not call the CP at all", async (t) => {
  const env = setup({ enrolled: false });
  const cp = await startStubCp(env.pod.publicKey);
  t.after(cp.close);
  const outcome = await makePuller(env, cp.url, []).pollOnce();
  assert.equal(outcome.skipped, "not-enrolled");
  assert.equal(cp.state.requests.length, 0);
});

test("a result the CP could not take is re-sent on the next poll", async (t) => {
  const env = setup({ policy: { mode: "managed" } });
  const cp = await startStubCp(env.pod.publicKey);
  t.after(cp.close);
  const ran = [];
  const puller = makePuller(env, cp.url, ran);
  cp.state.failResults = 1;
  cp.state.queue.push({
    id: "c7",
    token: commandToken(env, cp.url, { command: "update", commandId: "c7" }),
  });
  await pollAndSettle(puller);
  assert.equal(cp.state.results.length, 0);
  await pollAndSettle(puller);
  assert.equal(cp.state.results.length, 1);
  assert.equal(cp.state.results[0].id, "c7");
  assert.equal(ran.length, 1);
});
