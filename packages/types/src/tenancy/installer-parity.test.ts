/**
 * The installer `synap` is bash and cannot import this module, so it carries
 * its own copy of the naming: `synap_tenant_zones`, `synap_legacy_tenant_zones`,
 * `synap_pod_name_ok`, `pod_admin_domain_for_domain`, `shared_cookie_domain`,
 * `synap_first_party_web_origins` and `SYNAP_POD_ZONE` (the zone `--name`
 * installs under). This test runs those functions, extracted from the real
 * file the way deploy/__tests__ do, and asks them what this module answers.
 * Change one, change the other in the same commit.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  consoleHostForPod,
  firstPartyWebOrigins,
  LEGACY_TENANT_ZONES,
  isPodName,
  sharedCookieDomain,
  TENANT_ZONES,
} from "./index";

const INSTALLER = fileURLToPath(new URL("../../../../synap", import.meta.url));
const FUNCTIONS = [
  "synap_tenant_zones",
  "synap_legacy_tenant_zones",
  "synap_pod_name_ok",
  "synap_is_tenant_zone",
  "pod_admin_domain_for_domain",
  "is_public_suffix",
  "common_parent_domain",
  "shared_cookie_domain",
  "synap_first_party_web_origins",
] as const;

const dir = mkdtempSync(join(tmpdir(), "tenancy-parity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The installer's functions, cut out of the real file (no top-level code runs). */
function library(): string {
  const src = readFileSync(INSTALLER, "utf8").split("\n");
  const out: string[] = [];
  for (const name of FUNCTIONS) {
    const start = src.findIndex((l) => l.startsWith(`${name}() {`));
    if (start < 0) throw new Error(`synap has no ${name}()`);
    const end = src.findIndex((l, i) => i > start && l.startsWith("}"));
    out.push(...src.slice(start, end + 1));
  }
  return out.join("\n");
}

const LIB = join(dir, "lib.sh");
writeFileSync(LIB, library());
// An empty Public Suffix List: the answers must not depend on the host's list.
const PSL = join(dir, "psl.dat");
writeFileSync(PSL, "");

/** Run one installer function per argument list; one output per call. */
function sh(fn: (typeof FUNCTIONS)[number], calls: string[][]): string[] {
  const script = [
    `. "$1"`,
    `shift`,
    `while [ $# -gt 0 ]; do`,
    `  n="$1"; shift; args=("\${@:1:$n}"); shift "$n"`,
    `  out="$(${fn} "\${args[@]}")"; rc=$?`,
    `  printf '%s\\t%s\\x1e' "$rc" "$out"`,
    `done`,
  ].join("\n");
  const argv = calls.flatMap((c) => [String(c.length), ...c]);
  const raw = execFileSync("bash", ["-c", script, "parity", LIB, ...argv], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SYNAP_PSL_FILE: PSL },
  });
  return raw
    .split("\x1e")
    .slice(0, calls.length)
    .map((r) => {
      const [rc, ...rest] = r.split("\t");
      return rc === "0" ? rest.join("\t") : `<rc ${rc}>`;
    });
}

const HOSTS = [
  "alice.pod.synap.live",
  "Alice.Pod.Synap.Live",
  "team-2.pod.synap.live",
  `${"a".repeat(32)}.pod.synap.live`,
  `${"a".repeat(33)}.pod.synap.live`,
  "a.pod.staging.synap.live",
  "admin.alice.pod.synap.live",
  "shop.alice.pod.synap.live",
  "admin.pod.synap.live",
  "-a.pod.synap.live",
  "pod.synap.live",
  "pod.staging.synap.live",
  "synap.live",
  "staging.synap.live",
  "pod.alice.synap.live",
  "pod.alice.staging.synap.live",
  "pod-admin.alice.synap.live",
  "x.pod.alice.synap.live",
  "alice.synap.live",
  "alice.staging.synap.live",
  "pod.example.com",
  "synap.example.com",
  "pod.acme.co.uk",
  "localhost",
  "intranet",
  "pod.pod.synap.live",
  "pod-admin.pod.synap.live",
  "pod.pod-admin.synap.live",
  "synap.live.",
  "pod.synap.live.",
  "x.POD.synap.live",
  "alice.pod.synap.live.",
];

describe("installer parity: the zones", () => {
  it("lists the same tenant zones, current and legacy", () => {
    const [current, legacy] = [
      sh("synap_tenant_zones", [[]])[0],
      sh("synap_legacy_tenant_zones", [[]])[0],
    ];
    expect(current.split("\n")).toEqual([...TENANT_ZONES]);
    expect(legacy.split("\n").sort()).toEqual([...LEGACY_TENANT_ZONES].sort());
  });

  it("installs `--name` pods under the first tenant zone", () => {
    const installer = readFileSync(INSTALLER, "utf8");
    expect(installer).toMatch(
      new RegExp(
        `^SYNAP_POD_ZONE="${TENANT_ZONES[0].replace(/\./g, "\\.")}"$`,
        "m"
      )
    );
    expect(installer).toMatch(
      /^ {8}DOMAIN="\$\{POD_NAME\}\.\$\{SYNAP_POD_ZONE\}"$/m
    );
  });

  it("refuses every zone as a cookie domain", () => {
    const zones = [...TENANT_ZONES, ...LEGACY_TENANT_ZONES];
    expect(
      sh(
        "is_public_suffix",
        zones.map((z) => [z])
      )
    ).toEqual(zones.map(() => ""));
  });
});

describe("installer parity: the naming", () => {
  it("accepts the same pod names", () => {
    const names = [
      "a",
      "alice",
      "team-2",
      "a".repeat(32),
      "a".repeat(33),
      "-a",
      "a-",
      "A",
      "a_b",
      "admin",
      "pod",
      "pod-admin",
    ];
    const want = names.map((n) => (isPodName(n) ? "" : "<rc 1>"));
    expect(
      sh(
        "synap_pod_name_ok",
        names.map((n) => [n])
      )
    ).toEqual(want);
  });

  it("gives every host the same console", () => {
    const got = sh(
      "pod_admin_domain_for_domain",
      HOSTS.map((h) => [h])
    );
    expect(Object.fromEntries(HOSTS.map((h, i) => [h, got[i]]))).toEqual(
      Object.fromEntries(HOSTS.map((h) => [h, consoleHostForPod(h) ?? ""]))
    );
  });

  it("scopes the same session cookie for a pod and its console", () => {
    const pairs = HOSTS.filter((h) => consoleHostForPod(h)).map((h) => [
      h,
      consoleHostForPod(h) as string,
    ]);
    pairs.push(
      ["a.pod.synap.live", "admin.b.pod.synap.live"],
      ["pod.a.com", "admin.b.org"]
    );
    const got = sh("shared_cookie_domain", pairs);
    expect(
      Object.fromEntries(pairs.map((p, i) => [p.join(" + "), got[i]]))
    ).toEqual(
      Object.fromEntries(
        pairs.map(([p, c]) => [`${p} + ${c}`, sharedCookieDomain(p, c) ?? ""])
      )
    );
  });

  it("admits the same Synap apps", () => {
    const hosts = [
      "alice.pod.synap.live",
      "a.pod.staging.synap.live",
      "pod.x.staging.synap.live",
      "pod.example.com",
    ];
    const got = sh(
      "synap_first_party_web_origins",
      hosts.map((h) => [h])
    );
    expect(got.map((o) => o.split("\n"))).toEqual(
      hosts.map(firstPartyWebOrigins)
    );
  });
});
