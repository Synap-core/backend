"use strict";

// D15: a pod archive leaves the host ONLY age-encrypted. Drives the real
// deploy/archive-pod.sh and deploy/restore-archive-pod.sh with fake `docker`,
// `age` and `wget` on PATH (nothing real is started, nothing leaves the
// machine): no recipient refuses before any service stops; with one, the
// uploaded body is the age file and the plaintext tarball is gone; an
// encrypted archive without its identity refuses to restore.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { archiveManifestFrom } = require("./archive-manifest");

const DEPLOY = path.join(__dirname, "..");
const RECIPIENT =
  "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

function fakeBin(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const write = (name, body) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
  // Each volume key resolves to one volume holding one file; `docker run`
  // answers the helper's count (1 file, 5 bytes) and streams a real tarball.
  write(
    "docker",
    `echo "docker $*" >> "$FAKE_LOG"
case "$*" in
  *pg_dumpall*) echo "SELECT 1;" ;;
  "volume ls"*) echo "$*" | sed -n 's/.*com.docker.compose.volume=\\([a-z_]*\\).*/pod_\\1/p' ;;
  "run "*"tar czf"*) d=$(mktemp -d); echo data > "$d/f"; tar czf - -C "$d" . ;;
  "run "*) printf '1\\n5\\n' ;;
esac
exit 0`
  );
  // Fake age: -o OUT IN → header line + input (enough to prove the call).
  write(
    "age",
    `echo "age $*" >> "$FAKE_LOG"
out=""; in=""; dec=0
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; -r|-i) shift 2 ;; -d) dec=1; shift ;; *) in="$1"; shift ;; esac
done
if [ "$dec" = 1 ]; then tail -n +2 "$in" > "$out"; else { echo "age-encryption.org/v1"; cat "$in"; } > "$out"; fi`
  );
  // Fake wget: record the uploaded body's first line; never touch a network.
  write(
    "wget",
    `echo "wget $*" >> "$FAKE_LOG"
for a in "$@"; do case "$a" in --body-file=*) head -n 1 "\${a#--body-file=}" > "$FAKE_UPLOAD_HEAD" ;; esac; done
exit 0`
  );
  return bin;
}

// The scripts run from a COPY of the deploy dir: they hand every container
// start to the host (host-request.sh → <deploy>/state/requests/compose.json),
// and that state must land in the sandbox, never in the checkout. A fake HOST
// takes each request, logs it as "host-compose <services json>" and records
// success, the way `synap compose-request` does (deploy/__tests__/
// host-compose-request.test.sh covers the real host side).
const FAKE_HOST = `D="$1"
while :; do
  if [ -f "$D/state/requests/compose.json" ] && mv -f "$D/state/requests/compose.json" "$D/state/requests/taken.json" 2>/dev/null; then
    id=$(sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p' "$D/state/requests/taken.json")
    echo "host-compose $(sed -n 's/.*"services":\\(\\[[^]]*\\]\\).*/\\1/p' "$D/state/requests/taken.json")" >> "$FAKE_LOG"
    printf '{"kind":"pod.compose-request","status":"succeeded","request":"%s","reason":""}\\n' "$id" > "$D/state/last-compose-request.json"
  fi
  sleep 0.2
done`;
const hosts = [];
test.after(() => hosts.forEach((h) => h.kill("SIGKILL")));

function run(sb, script, args, env = {}) {
  return spawnSync("sh", [path.join(sb.deploy, script), ...args], {
    env: { ...sb.env, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-d15-"));
  const bin = fakeBin(dir);
  const work = path.join(dir, "work");
  fs.mkdirSync(work);
  const deploy = path.join(dir, "deploy");
  fs.mkdirSync(deploy);
  for (const f of fs.readdirSync(DEPLOY)) {
    if (f.endsWith(".sh") || f === "docker-compose.yml") {
      fs.copyFileSync(path.join(DEPLOY, f), path.join(deploy, f));
    }
  }
  fs.writeFileSync(
    path.join(deploy, ".env"),
    `SYNAP_IMAGE_POD_AGENT=ghcr.io/synap-core/pod-agent@sha256:${"a".repeat(64)}\n`
  );
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    FAKE_LOG: path.join(dir, "fake.log"),
    FAKE_UPLOAD_HEAD: path.join(dir, "upload-head"),
    ARCHIVE_WORK_DIR: work,
    HOST_REQUEST_POLL_SECONDS: "1",
    HOST_REQUEST_PICKUP_SECONDS: "10",
  };
  const host = spawn("sh", ["-c", FAKE_HOST, "fake-host", deploy], {
    env,
    stdio: "ignore",
  });
  hosts.push(host);
  return { dir, work, deploy, log: env.FAKE_LOG, env };
}

const readLog = (sb) =>
  fs.existsSync(sb.log) ? fs.readFileSync(sb.log, "utf8") : "";

test("archive with no recipient refuses before stopping anything", () => {
  const sb = sandbox();
  const r = run(sb, "archive-pod.sh", ["https://upload.invalid/x", "", ""]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ARCHIVE_RECIPIENT_MISSING/);
  assert.doesNotMatch(readLog(sb), /docker .*stop/);
});

test("a non-age recipient refuses before stopping anything", () => {
  const sb = sandbox();
  const r = run(sb, "archive-pod.sh", ["https://upload.invalid/x", "", ""], {
    ARCHIVE_AGE_RECIPIENTS: "ssh-ed25519",
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ARCHIVE_RECIPIENT_INVALID/);
  assert.doesNotMatch(readLog(sb), /docker .*stop/);
});

test("with a recipient, only the age file is uploaded and no plaintext is left", () => {
  const sb = sandbox();
  const r = run(sb, "archive-pod.sh", ["https://upload.invalid/x", "", ""], {
    ARCHIVE_AGE_RECIPIENTS: RECIPIENT,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = readLog(sb);
  assert.match(log, new RegExp(`age -r ${RECIPIENT} -o `));
  assert.match(log, /wget .*--body-file=\S+\.tar\.gz\.age/);
  assert.equal(
    fs.readFileSync(sb.env.FAKE_UPLOAD_HEAD, "utf8").trim(),
    "age-encryption.org/v1"
  );
  assert.deepEqual(fs.readdirSync(sb.work), []);
  // The last stdout line is the manifest pod-agent hands the CP.
  const manifest = archiveManifestFrom(r.stdout);
  assert.ok(manifest, r.stdout);
  assert.deepEqual(
    manifest.volumes.map((v) => [v.name, v.files, v.empty]),
    [
      ["minio_data", 1, false],
      ["typesense_data", 1, false],
    ]
  );
});

test("archiveManifestFrom reads the LAST manifest line, and never guesses", () => {
  assert.deepEqual(archiveManifestFrom('x\nARCHIVE_MANIFEST {"schema":1}\n'), {
    schema: 1,
  });
  assert.deepEqual(
    archiveManifestFrom(
      'ARCHIVE_MANIFEST {"schema":0}\nARCHIVE_MANIFEST {"schema":1}'
    ),
    { schema: 1 }
  );
  assert.equal(archiveManifestFrom("no manifest here"), null);
  assert.equal(archiveManifestFrom("ARCHIVE_MANIFEST {not json"), null);
  assert.equal(archiveManifestFrom(undefined), null);
});

test("an encrypted archive without its identity refuses to restore", () => {
  const sb = sandbox();
  // restore-archive-pod.sh downloads to /tmp/pod-archive.tar.gz; the fake
  // wget writes an age-headed file there via -O.
  fs.writeFileSync(
    path.join(sb.dir, "bin", "wget"),
    `#!/bin/sh
echo "wget $*" >> "$FAKE_LOG"
prev=""; for a in "$@"; do [ "$prev" = "-O" ] && { echo "age-encryption.org/v1"; echo "x"; } > "$a"; prev="$a"; done
exit 0
`,
    { mode: 0o755 }
  );
  const r = run(
    sb,
    "restore-archive-pod.sh",
    ["https://archive.invalid/a", "", ""],
    {
      ARCHIVE_AGE_IDENTITY_FILE: path.join(sb.dir, "missing-identity.txt"),
    }
  );
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ARCHIVE_IDENTITY_MISSING/);
  assert.doesNotMatch(readLog(sb), /^age /m);
});

test("a legacy plaintext archive still restores (no age involved)", () => {
  const sb = sandbox();
  // A real tar.gz the way pre-D15 archive-pod.sh made one (no db, no volumes).
  const src = path.join(sb.dir, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "volumes.tar.gz"), "");
  const legacy = path.join(sb.dir, "legacy.tar.gz");
  spawnSync("tar", ["czf", legacy, "-C", src, "volumes.tar.gz"]);
  fs.writeFileSync(
    path.join(sb.dir, "bin", "wget"),
    `#!/bin/sh
echo "wget $*" >> "$FAKE_LOG"
prev=""; for a in "$@"; do [ "$prev" = "-O" ] && [ "$a" != "/dev/null" ] && cp "${legacy}" "$a"; prev="$a"; done
exit 0
`,
    { mode: 0o755 }
  );
  const r = run(
    sb,
    "restore-archive-pod.sh",
    ["https://archive.invalid/a", "", ""],
    {
      ARCHIVE_AGE_IDENTITY_FILE: path.join(sb.dir, "missing-identity.txt"),
      RESTORE_HEALTH_TRIES: "1",
      RESTORE_HEALTH_INTERVAL: "0",
    }
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Archive extracted/);
  assert.match(r.stdout, /Restore complete/);
  assert.doesNotMatch(r.stdout, /decrypted/);
  assert.doesNotMatch(readLog(sb), /^age /m);
  // The services came back through the HOST (every service), never a compose
  // `up` run from the agent.
  assert.match(readLog(sb), /^host-compose \[\]$/m);
  assert.doesNotMatch(readLog(sb), /^docker .*\bup\b/m);
});
