// The code-skill runner's sandbox, proven on the BUILT artifact (review F12).
//
// The real-isolate suites run the runner from TypeScript under tsx, without
// the Node permission model (tsx needs a worker the model denies), so only a
// built runner carries it. ci.yml "Test Docker Build" runs this inside the
// image (cwd /app/api):
//
//   1. the API's own pool (`warmSkillRuntime`, from the built @synap/api)
//      starts a runner, and /health's `skillRuntime` would say `ready`;
//   2. that runner's command line, read from /proc, carries `--permission`;
//   3. a runner forked with exactly that command line runs a skill (6 * 7);
//   4. code under exactly those flags cannot write a file, start a process or
//      a worker, or read its parent's /proc/<pid>/environ (the API's secrets)
//      or /etc/passwd; it can still read isolated-vm (what it loads).
//
// Linux only (/proc). Exits non-zero, with the reason, on the first failure.
import { fork, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(msg) {
  console.error(`::error::skill runner sandbox: ${msg}`);
  process.exit(1);
}

// The pool reads no secret, but the API's config module wants a database URL
// at import; nothing connects to it.
process.env.DATABASE_URL ??= "postgresql://smoke:smoke@127.0.0.1:1/smoke";
const appRequire = createRequire(path.join(process.cwd(), "package.json"));
const api = await import(pathToFileURL(appRequire.resolve("@synap/api")).href);

// 1. The pool starts a runner.
await api.warmSkillRuntime();
const health = api.skillRuntimeHealth();
if (health.status !== "ready")
  fail(`the runner did not start: ${JSON.stringify(health)}`);

// 2. The runner it started carries the permission model.
const runners = readdirSync("/proc")
  .filter((d) => /^\d+$/.test(d))
  .map((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .split("\0")
        .filter(Boolean);
      return { ppid, argv };
    } catch {
      return null; // exited while we looked
    }
  })
  .filter(
    (p) =>
      p &&
      p.ppid === process.pid &&
      p.argv.some((a) => a.endsWith("skill-runner-child.js"))
  );
if (runners.length !== 1)
  fail(`expected the 1 runner the pool started, found ${runners.length}`);
const argv = runners[0].argv;
const entryAt = argv.findIndex((a) => a.endsWith("skill-runner-child.js"));
const flags = argv.slice(1, entryAt);
console.log(`runner flags: ${flags.join(" ")}`);
if (!flags.includes("--permission"))
  fail("the runner runs without --permission (the Node permission model)");

// 3. A runner with exactly those flags runs a skill.
const value = await new Promise((resolve, reject) => {
  const child = fork(argv[entryAt], [], {
    execArgv: flags,
    env: {},
    serialization: "advanced",
  });
  const timer = setTimeout(
    () => reject(new Error("no answer in 10 s")),
    10_000
  );
  child.on("message", (m) => {
    if (m.type === "ready")
      child.send({
        type: "run",
        runId: "smoke",
        code: "return 6 * 7;",
        args: {},
        context: { userId: "smoke", workspaceId: null, agentUserId: null },
        timeoutMs: 2_000,
      });
    else if (m.type === "fatal" || m.type === "done") {
      clearTimeout(timer);
      child.kill();
      if (m.type === "done" && m.ok) resolve(m.value);
      else reject(new Error(m.error));
    }
  });
}).catch((err) =>
  fail(`a sandboxed runner could not run a skill: ${err.message}`)
);
if (value !== 42) fail(`the skill returned ${value}, not 42`);
console.log("a sandboxed runner ran a skill: 6 * 7 = 42");

// 4. What those flags refuse.
const ivm = path.dirname(
  createRequire(argv[entryAt]).resolve("isolated-vm/package.json")
);
const probe = `
const fs = require("node:fs");
const out = {};
const t = (k, f) => { try { f(); out[k] = "allowed"; } catch (e) { out[k] = e.code || e.message; } };
t("write a file", () => fs.writeFileSync("/tmp/skill-runner-probe", "x"));
t("start a process", () => { const r = require("node:child_process").spawnSync("true"); if (r.error) throw r.error; });
t("start a worker", () => new (require("node:worker_threads").Worker)("0", { eval: true }));
t("read the parent's /proc/<pid>/environ", () => fs.readFileSync("/proc/" + process.ppid + "/environ"));
t("read /etc/passwd", () => fs.readFileSync("/etc/passwd"));
t("read isolated-vm", () => fs.readFileSync(${JSON.stringify(path.join(ivm, "package.json"))}));
console.log(JSON.stringify(out));
`;
const ran = spawnSync(process.execPath, [...flags, "-e", probe], {
  encoding: "utf8",
  env: {},
});
let seen;
try {
  seen = JSON.parse(ran.stdout.trim().split("\n").pop());
} catch {
  fail(`the probe did not answer: ${ran.stdout} ${ran.stderr}`);
}
console.log(`under the runner's flags: ${JSON.stringify(seen)}`);
for (const [what, got] of Object.entries(seen)) {
  const want = what === "read isolated-vm" ? "allowed" : "ERR_ACCESS_DENIED";
  if (got !== want) fail(`${what}: ${got} (want ${want})`);
}
console.log("skill runner sandbox: OK");
process.exit(0);
