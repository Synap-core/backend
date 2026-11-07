/**
 * The contracts migration 0398 seeds (plan U1, addendum 000e75ff §4), read out
 * of the migration SQL, not copied, so the test checks what a pod is seeded
 * with, through the pod's own JSON Schema reader (`validateInput`). Each case
 * rules out one wrong migration:
 *  - a contract whose frame the resolver cannot read (no output, an op with no
 *    input, an unknown op, a create op carrying a second copy of the input);
 *  - `expose_http` letting a provider qualify without `status` or `revoke`
 *    (a URL nobody can check or tear down);
 *  - an input or output schema the pod's reader cannot compile, or one that
 *    accepts what it must refuse (an http source on no port, a `public` that is
 *    not a boolean, an extra field);
 *  - `host_service` letting a provider qualify without `revoke` (containers
 *    nobody can remove);
 *  - an intent seeded without a contract or without its one input.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  intentContractProblems,
  isIntentContract,
  missingIntentOps,
  requiredIntentOps,
  type IntentContract,
} from "@synap-core/types/capability-intents";
import { validateInput } from "./intent-input.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// src/services/capabilities → src → api → packages
const SQL = readFileSync(
  resolve(
    HERE,
    "../../../../database/migrations/0398_reachability_intents.sql"
  ),
  "utf8"
);

const SEEDED = [
  "expose_http",
  "open_tunnel",
  "dns_record",
  "host_service",
  "render_video",
] as const;

function literals(column: "input_schema" | "contract") {
  const out = new Map<string, Record<string, unknown>>();
  const re = new RegExp(
    `SET "${column}" = '([\\s\\S]*?)'::jsonb\\s*WHERE "slug" = '([a-z_]+)'`,
    "g"
  );
  for (const m of SQL.matchAll(re)) out.set(m[2]!, JSON.parse(m[1]!));
  return out;
}
const INPUTS = literals("input_schema");
// A cast through `unknown`: the literals are parsed JSON, checked by
// `intentContractProblems` below, not by the compiler.
const CONTRACTS = literals("contract") as unknown as Map<
  string,
  IntentContract
>;

const contract = (slug: string) => CONTRACTS.get(slug)!;
const output = (slug: string) => contract(slug).output;

const INSTALLATION = "7b0c9f7e-4c1d-4a55-9d0e-2f6a1c3b8e01";
const FILE = "3a1f6c2e-9b7d-4e8a-a1c0-5d2e7f9b4c66";

describe("0398 — every seeded intent has its one input and a readable contract", () => {
  it("seeds exactly the five rows, each with both shapes (non-vacuity)", () => {
    expect([...INPUTS.keys()].sort()).toEqual([...SEEDED].sort());
    expect([...CONTRACTS.keys()].sort()).toEqual([...SEEDED].sort());
  });

  it.each(SEEDED)("%s: the contract's frame is well formed", (slug) => {
    expect(intentContractProblems(contract(slug))).toEqual([]);
    expect(isIntentContract(contract(slug))).toBe(true);
  });

  it.each(SEEDED)(
    "%s: every op has an input (create's is the row's input_schema) and every op returns the output",
    (slug) => {
      const c = contract(slug);
      for (const [op, spec] of Object.entries(c.ops)) {
        const input = op === "create" ? INPUTS.get(slug) : spec?.input;
        expect(input, `${slug}.${op} input`).toMatchObject({ type: "object" });
        // The pod's reader compiles it: an unreadable schema is a refusal.
        const probe = validateInput(input!, {});
        if (!probe.ok) {
          for (const issue of probe.issues) {
            expect(issue.message).not.toMatch(/cannot be read/);
          }
        }
      }
      expect(c.output).toMatchObject({ type: "object" });
    }
  );
});

describe("0398 — the lifecycle each contract demands of a provider", () => {
  it("expose_http requires create, status and revoke; renew is owed once an expiry is returned", () => {
    const c = contract("expose_http");
    expect(requiredIntentOps(c)).toEqual(["create", "status", "revoke"]);
    expect(c.ops.renew).toMatchObject({
      required: false,
      requiredWhen: "expiresAt",
    });
    // A provider that cannot revoke is a misfit, with the reason named.
    expect(missingIntentOps(c, ["create", "status"])).toEqual(["revoke"]);
    expect(missingIntentOps(c, ["create", "status", "revoke"])).toEqual([]);
  });

  it("open_tunnel and dns_record require create, status and revoke", () => {
    expect(requiredIntentOps(contract("open_tunnel"))).toEqual([
      "create",
      "status",
      "revoke",
    ]);
    expect(requiredIntentOps(contract("dns_record"))).toEqual([
      "create",
      "status",
      "revoke",
    ]);
  });

  it("host_service requires create, status and revoke, and declares no renew", () => {
    const c = contract("host_service");
    expect(requiredIntentOps(c)).toEqual(["create", "status", "revoke"]);
    expect(c.ops.renew).toBeUndefined();
    expect(c.constraints).toEqual(["os", "arch", "resources", "runsOn"]);
  });

  it("render_video is a run, not a living thing: create is required, status optional, no revoke", () => {
    const c = contract("render_video");
    expect(requiredIntentOps(c)).toEqual(["create"]);
    expect(c.ops.status?.required).toBe(false);
    expect(c.ops.revoke).toBeUndefined();
  });

  it("the constraint keys a need may set are declared, never empty", () => {
    expect(contract("expose_http").constraints).toEqual(
      expect.arrayContaining(["auth", "source", "hostname", "runsOn", "public"])
    );
    for (const slug of SEEDED) {
      expect(contract(slug).constraints.length).toBeGreaterThan(0);
    }
  });
});

describe("0398 — the shapes accept what they must and refuse the rest", () => {
  const exposeCreate = {
    installationId: INSTALLATION,
    needKey: "studio_url",
    computer: "410cae52",
    source: { kind: "local_port", port: 3002, protocol: "http" },
    hostname: { subdomain: "hyperframes" },
    auth: "tailnet",
  };

  it("expose_http accepts a local port behind tailnet", () => {
    expect(validateInput(INPUTS.get("expose_http")!, exposeCreate).ok).toBe(
      true
    );
  });

  it("expose_http refuses a local_port source with no port, and an extra field", () => {
    const schema = INPUTS.get("expose_http")!;
    expect(
      validateInput(schema, {
        ...exposeCreate,
        source: { kind: "local_port" },
      }).ok
    ).toBe(false);
    expect(validateInput(schema, { ...exposeCreate, extra: true }).ok).toBe(
      false
    );
    expect(
      validateInput(schema, {
        ...exposeCreate,
        hostname: { fqdn: "Not A Host" },
      }).ok
    ).toBe(false);
  });

  it("expose_http's output carries url, state, handle, authApplied and a boolean public", () => {
    const live = {
      url: "http://devbox.internal.synap.live:3002",
      state: "live",
      handle: { route: "r1" },
      authApplied: "tailnet",
      public: false,
      expiresAt: null,
      checkedAt: "2026-11-04T16:00:00.000Z",
      detail: "Healthy.",
    };
    expect(validateInput(output("expose_http"), live).ok).toBe(true);
    expect(
      validateInput(output("expose_http"), { ...live, public: "no" }).ok
    ).toBe(false);
    expect(
      validateInput(output("expose_http"), { ...live, state: "up" }).ok
    ).toBe(false);
    const { authApplied: _a, ...noAuth } = live;
    expect(validateInput(output("expose_http"), noAuth).ok).toBe(false);
  });

  it("status and revoke read back the handle create returned", () => {
    const status = contract("expose_http").ops.status!.input!;
    expect(
      validateInput(status, {
        installationId: INSTALLATION,
        needKey: "studio_url",
        handle: ["t1", "d1"],
      }).ok
    ).toBe(true);
    expect(
      validateInput(status, { installationId: INSTALLATION, needKey: "x" }).ok
    ).toBe(false);
  });

  it("host_service takes the services to run on one computer, and refuses none", () => {
    const schema = INPUTS.get("host_service")!;
    const run = {
      installationId: INSTALLATION,
      needKey: "runtime",
      computer: "410cae52",
      services: [{ id: "render" }],
    };
    expect(validateInput(schema, run).ok).toBe(true);
    expect(validateInput(schema, { ...run, services: [] }).ok).toBe(false);
  });

  it("dns_record accepts one CNAME and refuses a record type it does not know", () => {
    const schema = INPUTS.get("dns_record")!;
    const cname = {
      installationId: INSTALLATION,
      needKey: "dns",
      zone: "synap.live",
      name: "hyperframes-antoinesrvt.synap.live",
      type: "CNAME",
      target: "t1.tunnel.example",
    };
    expect(validateInput(schema, cname).ok).toBe(true);
    expect(validateInput(schema, { ...cname, type: "MX" }).ok).toBe(false);
  });

  it("render_video takes a pod file and a format, and returns pod files", () => {
    const schema = INPUTS.get("render_video")!;
    expect(
      validateInput(schema, {
        compositionFileId: FILE,
        format: "mp4",
        width: 1920,
        height: 1080,
      }).ok
    ).toBe(true);
    expect(validateInput(schema, { compositionFileId: FILE }).ok).toBe(false);
    expect(
      validateInput(output("render_video"), {
        state: "done",
        handle: "run-1",
        fileIds: [FILE],
      }).ok
    ).toBe(true);
  });
});

describe("intentContractProblems — the checker refuses each broken frame", () => {
  const good = contract("expose_http");

  it("names each problem", () => {
    expect(intentContractProblems(null)).toEqual([
      "The contract is not an object.",
    ]);
    expect(intentContractProblems({ ...good, version: 2 })).toContain(
      "The contract's version is not 1."
    );
    const { output: _o, ...noOutput } = good;
    expect(intentContractProblems(noOutput)).toContain(
      "The contract declares no output schema."
    );
    expect(
      intentContractProblems({ ...good, ops: { status: good.ops.status } })
    ).toContain("The contract has no create op.");
    expect(
      intentContractProblems({
        ...good,
        ops: { ...good.ops, delete: { required: true, input: {} } },
      })
    ).toContain(
      '"delete" is not an op (they are create, status, renew, revoke).'
    );
    expect(
      intentContractProblems({
        ...good,
        ops: { ...good.ops, revoke: { required: true } },
      })
    ).toContain("The revoke op declares no input schema.");
    expect(
      intentContractProblems({
        ...good,
        ops: { ...good.ops, create: { required: true, input: {} } },
      })
    ).toContain(
      "The create op declares its own input; it is the intent's input_schema."
    );
    expect(
      intentContractProblems({ ...good, constraints: ["auth", "auth"] })
    ).toContain("The contract's constraints repeat a key.");
  });
});
